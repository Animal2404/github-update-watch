/**
 * 截图工具（不消耗 GitHub 额度）：只负责打开页面、切主题、拍图。
 * 需要单独看某个状态时用它，跑完整按钮验证用 tools/verify-ui.mjs。
 *
 *   node tools/shots.mjs [appUrl] [输出前缀]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, HEADLESS_ARGS } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.argv[2] || 'http://127.0.0.1:7321/';
const PREFIX = process.argv[3] || 'shot';
const OUT = path.join(ROOT, 'data', 'shots');
const RUN_ID = Date.now() % 100000;
const PORT = 16900 + (RUN_ID % 200);
fs.mkdirSync(OUT, { recursive: true });

const CHROME = findChrome();
if (!CHROME) { console.error('找不到 Chrome/Edge（可用 CHROME_PATH 指定）'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mobile = process.argv.includes('--mobile');
const profile = path.join(ROOT, 'data', 'tmp', `chrome-shots-${RUN_ID}`);
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  ...HEADLESS_ARGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--window-size=' + (mobile ? '420,900' : '1280,900'),
  '--force-device-scale-factor=1', APP,
], { stdio: 'ignore' });

let ws;
try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 等 */ }
  }
  if (!target) throw new Error('连不上调试端口');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`${name} → ${file}`);
  };
  await send('Page.enable');
  await sleep(2200);   // 等首屏数据与卡片入场动画
  await shot(`${PREFIX}-dark`);
  await evaluate(`document.querySelector('#themeBtn').click()`);
  await sleep(700);
  await shot(`${PREFIX}-light`);
  await evaluate(`document.querySelector('#themeBtn').click()`);
  await sleep(400);
} finally {
  try { ws?.close(); } catch {}
  try { chrome.kill(); } catch {}
}
