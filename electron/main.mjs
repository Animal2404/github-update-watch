/**
 * Electron 桌面壳
 * ---------------------------------------------------------------------------
 * 桌面版不是另写一套界面：它起的是同一个 server.mjs（同一份 public/ 界面 +
 * 同一份 github-core 逻辑），只是把它包进一个原生窗口里，并改成从系统浏览器
 * 打开外链。所以桌面版 / 网页版 / 安卓 APK 三端功能一致是结构决定的。
 */
import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// 关键顺序：数据目录必须在 import server.mjs **之前**设好，
// 因为 server.mjs 在模块加载时就会读它。
process.env.GUW_DATA_DIR = app.getPath('userData');
process.env.PORT = '0';   // 0 = 让系统分配空闲端口，避免和已开的实例撞车

const { createServer, store, SEED, load } = await import(path.join(DIR, '..', 'server.mjs'));

let server = null;
let win = null;

async function startServer() {
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  if (!load()) await store.seed(SEED);   // 首次运行给几个示例项目
  return `http://127.0.0.1:${server.address().port}/`;
}

async function createWindow() {
  const url = await startServer();
  win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 380,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    show: false,
    title: 'GitHub 更新监测',
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  // 卡片上的外链（仓库主页 / Release 页）交给系统默认浏览器，不在窗口里开
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  await win.loadURL(url);
}

app.setAppUserModelId('com.guw.watch');

app.whenReady().then(createWindow).catch((e) => {
  console.error('启动失败:', e);
  app.quit();
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => {
  try { server?.close(); } catch { /* 忽略 */ }
  app.quit();
});
