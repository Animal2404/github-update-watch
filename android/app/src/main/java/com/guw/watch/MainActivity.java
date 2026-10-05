package com.guw.watch;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

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

        if (savedInstanceState == null) {
            web.loadUrl(START_URL);
        } else {
            web.restoreState(savedInstanceState);
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
