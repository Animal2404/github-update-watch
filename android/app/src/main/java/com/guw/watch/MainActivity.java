package com.guw.watch;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * 整个 APK 就是一个 WebView：界面与逻辑跟电脑版是**同一份** public/ 资源，
 * 由 tools/sync-android-assets.mjs 在构建前同步进 assets/www。
 *
 * 几个要点：
 *  · 用 WebViewAssetLoader 把资源挂在 https://appassets.androidplatform.net/ 下，
 *    而不是 file://——file:// 是 opaque origin，localStorage 与 fetch 的行为都不靠谱；
 *  · 页面带 ?mode=direct，前端据此用「直连模式」（浏览器直接请求 api.github.com，数据存 localStorage）；
 *  · WebView 不支持 Web Notification API，所以「有新版本弹通知」由 AndroidNotify 桥走原生通知，
 *    这样手机和电脑的行为才一致；
 *  · 外链（仓库主页 / Release 页）交给系统浏览器，不在 App 里开。
 */
public class MainActivity extends Activity {

    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START_URL = ORIGIN + "/assets/www/index.html?mode=direct";
    private static final String CHANNEL_ID = "guw-updates";
    private static final int NOTIFY_ID = 1001;
    private static final int REQ_POST_NOTIFICATIONS = 41;

    private WebView web;
    private long updateDownloadId = -1;
    private BroadcastReceiver downloadReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage：直连模式的存储
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        WebView.setWebContentsDebuggingEnabled(true);   // 方便 chrome://inspect 排查

        // 原生通知桥：页面里 window.AndroidNotify.notify(title, body)
        web.addJavascriptInterface(new NotifyBridge(), "AndroidNotify");
        web.addJavascriptInterface(new ThemeBridge(), "AndroidTheme");
        web.addJavascriptInterface(new HttpBridge(), "AndroidHttp");
        web.addJavascriptInterface(new UpdateBridge(), "AndroidUpdate");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (ORIGIN.equals(uri.getScheme() + "://" + uri.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // 没有可处理的 App 就算了，别崩
                }
                return true;
            }
        });

        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        applyBars(false);
        if (savedInstanceState == null) {
            web.loadUrl(START_URL);
        } else {
            web.restoreState(savedInstanceState);
        }
    }

    // ---------------------------------------------------------------- 主题栏
    /** 状态栏/导航栏跟随网页主题；页面里的 applyTheme() 会调用它 */
    public class ThemeBridge {
        @JavascriptInterface
        public void setTheme(final String theme) {
            runOnUiThread(() -> applyBars("light".equals(theme)));
        }
    }

    private String currentVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0.0.0";
        }
    }

    private void applyBars(boolean light) {
        int bg = light ? Color.WHITE : Color.parseColor("#09090B");
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().setNavigationBarDividerColor(bg);
        }
        int flags = getWindow().getDecorView().getSystemUiVisibility();
        if (Build.VERSION.SDK_INT >= 23) {
            flags = light ? (flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR)
                          : (flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
        if (Build.VERSION.SDK_INT >= 26) {
            flags = light ? (flags | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR)
                          : (flags & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
        getWindow().getDecorView().setSystemUiVisibility(flags);
        if (web != null) web.setBackgroundColor(bg);
    }

    // ---------------------------------------------------------------- 原生 HTTP（订阅）
    /**
     * 订阅站几乎都不给 WebView 发 CORS 头，subscription-userinfo 也不在 exposed headers 里，
     * 所以订阅必须由原生发请求，再把 status/headers/body 回传给网页。
     */
    public class HttpBridge {
        @JavascriptInterface
        public void fetch(final String id, final String url, final String headersJson) {
            new Thread(() -> {
                JSONObject out = new JSONObject();
                try {
                    JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
                    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(25000);
                    conn.setInstanceFollowRedirects(true);
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        conn.setRequestProperty(key, headers.optString(key));
                    }
                    conn.setRequestProperty("Accept-Encoding", "identity");
                    int status = conn.getResponseCode();
                    InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                    if (stream != null) {
                        byte[] chunk = new byte[8192];
                        int read;
                        while ((read = stream.read(chunk)) > 0) {
                            buffer.write(chunk, 0, read);
                            if (buffer.size() > 2 * 1024 * 1024) break;   // 和网页侧一致的上限
                        }
                        stream.close();
                    }
                    String text = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
                    JSONObject headerOut = new JSONObject();
                    for (String name : new String[]{"subscription-userinfo", "content-type", "profile-web-page-url"}) {
                        String value = conn.getHeaderField(name);
                        if (value != null) headerOut.put(name, value);
                    }
                    out.put("status", status);
                    out.put("text", text);
                    out.put("headers", headerOut);
                } catch (Exception e) {
                    try {
                        out.put("status", 0);
                        out.put("text", "");
                        out.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
                        out.put("headers", new JSONObject());
                    } catch (Exception ignored) { }
                }
                final String payload = out.toString();
                web.post(() -> web.evaluateJavascript(
                        "window.__androidHttp && window.__androidHttp(" + JSONObject.quote(id) + "," + payload + ")", null));
            }).start();
        }
    }

    // ---------------------------------------------------------------- 自更新
    /**
     * 更新检测走 releases/latest 的 302 Location，不消耗 GitHub REST 额度；
     * 下载用系统 DownloadManager，装的时候交给系统安装器（不需要静默安装）。
     */
    public class UpdateBridge {
        @JavascriptInterface
        public void check() {
            new Thread(() -> {
                JSONObject out = new JSONObject();
                try {
                    out.put("current", currentVersion());
                    HttpURLConnection conn = (HttpURLConnection) new URL(
                            "https://github.com/Animal2404/github-update-watch/releases/latest").openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setRequestMethod("HEAD");
                    conn.setConnectTimeout(10000);
                    conn.setReadTimeout(10000);
                    int code = conn.getResponseCode();
                    String location = conn.getHeaderField("Location");
                    if ((code == 301 || code == 302) && location != null) {
                        String tag = location.substring(location.lastIndexOf('/') + 1);
                        out.put("latest", tag);
                        out.put("url", "https://github.com/Animal2404/github-update-watch/releases/tag/" + tag);
                        out.put("apk", "https://github.com/Animal2404/github-update-watch/releases/download/"
                                + tag + "/GitHubUpdateWatch-" + tag.replaceFirst("^v", "") + ".apk");
                    } else {
                        out.put("error", "HTTP " + code);
                    }
                } catch (Exception e) {
                    try {
                        out.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
                    } catch (Exception ignored) { }
                }
                final String payload = out.toString();
                web.post(() -> web.evaluateJavascript(
                        "window.__androidUpdate && window.__androidUpdate(" + payload + ")", null));
            }).start();
        }

        @JavascriptInterface
        public void install(String apkUrl) {
            try {
                if (Build.VERSION.SDK_INT >= 26
                        && !getPackageManager().canRequestPackageInstalls()) {
                    runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                            .setData(Uri.parse("package:" + getPackageName()))));
                    return;
                }
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                String name = "GitHubUpdateWatch-" + currentVersion() + "-update.apk";
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(apkUrl))
                        .setTitle("GitHub 更新监测")
                        .setMimeType("application/vnd.android.package-archive")
                        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        .setDestinationInExternalFilesDir(MainActivity.this, Environment.DIRECTORY_DOWNLOADS, name);
                updateDownloadId = dm.enqueue(request);

                if (downloadReceiver == null) {
                    downloadReceiver = new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context context, Intent intent) {
                            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                            if (id != updateDownloadId) return;
                            try {
                                DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
                                android.database.Cursor c = dm.query(query);
                                if (c != null && c.moveToFirst()) {
                                    int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                                        String file = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
                                        Uri uri = FileProvider.getUriForFile(MainActivity.this,
                                                "com.guw.watch.fileprovider", new File(Uri.parse(file).getPath()));
                                        Intent install = new Intent(Intent.ACTION_VIEW)
                                                .setDataAndType(uri, "application/vnd.android.package-archive")
                                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                        startActivity(install);
                                    }
                                }
                                if (c != null) c.close();
                            } catch (Exception ignored) { }
                        }
                    };
                    IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                    if (Build.VERSION.SDK_INT >= 33) {
                        registerReceiver(downloadReceiver, filter, Context.RECEIVER_EXPORTED);
                    } else {
                        registerReceiver(downloadReceiver, filter);
                    }
                }
            } catch (Exception e) {
                web.post(() -> web.evaluateJavascript(
                        "window.__androidUpdateError && window.__androidUpdateError(" + JSONObject.quote(e.getMessage()) + ")", null));
            }
        }
    }

    /** 暴露给网页的通知接口（JS 调用发生在后台线程，所以只做线程安全的事） */
    public class NotifyBridge {
        @JavascriptInterface
        public void notify(String title, String body) {
            postNotification(title, body);
        }
    }

    private void postNotification(String title, String body) {
        final NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "版本更新", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("检测到项目有新版本时提醒");
            nm.createNotificationChannel(channel);
        }

        // Android 13+ 需要运行时授权；本次先申请，授权后下次检查就会正常弹
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            runOnUiThread(() -> requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIFICATIONS));
            return;
        }

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true);
        nm.notify(NOTIFY_ID, builder.build());
    }

    @Override
    protected void onDestroy() {
        if (downloadReceiver != null) {
            try { unregisterReceiver(downloadReceiver); } catch (Exception ignored) { }
            downloadReceiver = null;
        }
        super.onDestroy();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
