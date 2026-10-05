/**
 * 验证「直连模式」（安卓 APK 走的就是这条路径）
 *
 *   node tools/verify-direct.mjs
 *
 * 做法：起一个**纯静态**服务（故意不带 /api），浏览器打不开 /api/ping 就会降级到
 * 直连模式——这正是 APK 里的情况（页面来自 appassets，没有服务端）。
 * 然后真去点界面：添加项目走的是浏览器直接请求 api.github.com（顺带验 CORS），
 * 数据落在 localStorage，刷新后仍在。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome, HEADLESS_ARGS } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = 7421;
// 每次跑用独立的调试端口 + profile：Chrome 会派生子进程，kill 父进程不一定收干净，
// 复用端口会连到上一次残留的标签页上（踩过：localStorage Access denied）。
const RUN_ID = Date.now() % 100000;
const CDP_PORT = 19300 + (RUN_ID % 200);
const OUT = path.join(ROOT, 'data', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const CHROME = findChrome();
if (!CHROME) { console.error('找不到 Chrome/Edge（可用 CHROME_PATH 指定）'); process.exit(2); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const staticServer = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) { res.writeHead(404).end('404'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d || 'ok' }); console.log(`PASS  ${name}${d ? `  — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: e.message }); console.log(`FAIL  ${name}  — ${e.message}`); }
}

await new Promise((r) => staticServer.listen(PORT, '127.0.0.1', r));
const profile = path.join(ROOT, 'data', 'tmp', `chrome-direct-${RUN_ID}`);
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, [...HEADLESS_ARGS, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--window-size=1280,900', '--force-device-scale-factor=1',
  `http://127.0.0.1:${PORT}/`], { stdio: 'ignore' });

let ws;
try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 等 */ }
  }
  if (!target) throw new Error('连不上调试端口');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 出错');
    return r?.result?.value;
  };
  const waitFor = async (expr, { timeout = 30000, label = expr } = {}) => {
    const t0 = Date.now();
    for (;;) {
      try { if (await evaluate(expr)) return true; } catch { /* 页面还没好 */ }
      if (Date.now() - t0 > timeout) throw new Error(`等待超时：${label}`);
      await sleep(200);
    }
  };
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, `${name}.png`); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f; };
  await send('Page.enable'); await send('Runtime.enable');

  // 干净起点
  await evaluate(`localStorage.clear()`);
  await evaluate(`location.reload()`);
  await sleep(1500);

  await check('无服务端时自动降级为「直连模式」', async () => {
    // 注意：window.__guw 在模块加载时就存在，但 boot 还没跑完——
    // 必须等 renderGrid 把 aria-busy 置回 false，否则会读到半成品状态（踩过）
    await waitFor(`document.querySelector('#grid')?.getAttribute('aria-busy') === 'false'`, { label: '应用启动完成' });
    const info = await evaluate(`(() => ({ backend: window.__guw.state.backend, transport: window.__guw.state.transport }))()`);
    assert(info.backend === 'direct', `期望 direct，实际 ${info.backend}`);
    return `backend=${info.backend} transport=${info.transport}`;
  });

  await check('空状态正确提示（localStorage 清空后）', async () => {
    const info = await evaluate(`(() => ({ cards: document.querySelectorAll('.repo-card').length, emptyHidden: document.querySelector('#emptyState').hidden, title: document.querySelector('#emptyTitle').textContent }))()`);
    assert(info.cards === 0 && info.emptyHidden === false, JSON.stringify(info));
    return `0 张卡片 + 空态「${info.title}」`;
  });

  await check('直连模式添加项目：浏览器直接请求 api.github.com（顺带验 CORS）', async () => {
    await evaluate(`(() => { const i = document.querySelector('#repoInput'); i.value = 'microsoft/TypeScript'; document.querySelector('#addForm').requestSubmit(); return true; })()`);
    await waitFor(`!!document.querySelector('.repo-card[data-id="microsoft/typescript"]')`, { timeout: 40000, label: '卡片出现' });
    const r = await evaluate(`(() => { const x = window.__guw.state.repos.find(r => r.id === 'microsoft/typescript'); return { baseline: x?.baseline, latest: x?.latest?.tag, stars: x?.stars, status: x?.status, err: x?.error }; })()`);
    assert(r.latest, `没取到版本，error=${r.err}`);
    assert(!r.err, `有错误：${r.err}`);
    return `基线=${r.baseline} stars=${r.stars} 状态=${r.status}`;
  });

  await check('升级路径：把基线改旧 → 界面变「有新版本」→ 标记已读后恢复', async () => {
    // 直接改 localStorage 模拟"上次看的时候还是老版本"
    await evaluate(`(() => {
      const k = 'guw-store-v1';
      const s = JSON.parse(localStorage.getItem(k));
      s.repos[0].baseline = 'v1.0.0';
      localStorage.setItem(k, JSON.stringify(s));
      location.reload();
      return true;
    })()`);
    await sleep(1600);
    await waitFor(`document.querySelector('.repo-card[data-id="microsoft/typescript"]')?.dataset.status === 'update'`, { timeout: 20000, label: '变成有新版本' });
    const badge = await evaluate(`document.querySelector('.repo-card[data-id="microsoft/typescript"] [data-testid="status-text"]').textContent`);
    const ackDisabled = await evaluate(`document.querySelector('.repo-card[data-id="microsoft/typescript"] [data-action="ack"]').disabled`);
    assert(badge === '有新版本', `徽章不对：${badge}`);
    assert(ackDisabled === false, '「标记已读」此时应当可用');
    await evaluate(`document.querySelector('.repo-card[data-id="microsoft/typescript"] [data-action="ack"]').click()`);
    await waitFor(`document.querySelector('.repo-card[data-id="microsoft/typescript"]')?.dataset.status === 'clean'`, { timeout: 20000, label: '已读后回到最新' });
    const after = await evaluate(`(() => { const x = window.__guw.state.repos.find(r => r.id === 'microsoft/typescript'); return { status: x.status, baseline: x.baseline, latest: x.latest.tag }; })()`);
    assert(after.status === 'clean' && after.baseline === after.latest, JSON.stringify(after));
    return `update → 已读 → clean（基线推进到 ${after.baseline}）`;
  });

  await check('数据持久化：刷新页面后列表与基线仍在（localStorage）', async () => {
    const before = await evaluate(`JSON.stringify(window.__guw.state.repos.map(r => [r.id, r.baseline, r.latest?.tag]))`);
    await evaluate(`location.reload()`);
    await waitFor(`document.querySelector('#grid')?.getAttribute('aria-busy') === 'false'`, { label: '重新加载完成' });
    const after = await evaluate(`JSON.stringify(window.__guw.state.repos.map(r => [r.id, r.baseline, r.latest?.tag]))`);
    assert(before === after, `刷新前后不一致：${before} vs ${after}`);
    return after.slice(0, 90);
  });

  await check('直连模式删除项目：localStorage 同步清掉', async () => {
    await evaluate(`document.querySelector('.repo-card [data-action="delete"]').click()`);
    await sleep(300);
    await evaluate(`document.querySelector('#confirmOkBtn').click()`);
    await waitFor(`window.__guw.state.repos.length === 0`, { timeout: 15000, label: '列表清空' });
    const stored = await evaluate(`JSON.parse(localStorage.getItem('guw-store-v1') || '{}').repos?.length ?? -1`);
    assert(stored === 0, `localStorage 里还剩 ${stored} 条`);
    return '界面与 localStorage 都清空';
  });

  await check('截图：直连模式界面（安卓 APK 用的就是这张脸）', async () => {
    await evaluate(`(() => { const i=document.querySelector('#repoInput'); i.value='facebook/react'; document.querySelector('#addForm').requestSubmit(); return true; })()`);
    await waitFor(`document.querySelectorAll('.repo-card').length > 0`, { timeout: 40000, label: '卡片出现' });
    await sleep(900);
    const f = await shot('07-direct-mode');
    return path.basename(f);
  });

  const pass = results.filter((r) => r.pass).length;
  fs.writeFileSync(path.join(ROOT, 'data', 'verify-direct-report.json'), JSON.stringify({ pass, total: results.length, results }, null, 2), 'utf8');
  console.log(`\n=== 直连模式 ${pass}/${results.length} 通过 ===`);
  process.exitCode = pass === results.length ? 0 : 1;
} catch (e) {
  console.error('测试脚本自身出错：', e.message);
  process.exitCode = 2;
} finally {
  try { ws?.close(); } catch {}
  try { chrome.kill(); } catch {}
  staticServer.close();
}
