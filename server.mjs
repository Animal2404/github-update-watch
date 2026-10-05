/**
 * GitHub 更新监测 · 本地服务（桌面版后端）
 * ---------------------------------------------------------------------------
 * 只做三件事：
 *   1. 静态托管 public/（网页版就是这套文件）
 *   2. 把「有没有新版本」的全部逻辑交给 public/github-core.js（与安卓 APK 同一份）
 *   3. 给 Node 侧注入网络传输与磁盘存储
 *
 * 传输退让链：fetch → curl --noproxy *（强制直连）→ curl（走系统代理）
 * 实测坑：系统设了 HTTP(S)_PROXY 但代理没开时，Node 的 fetch 会 ECONNREFUSED，
 * 而 curl 走直连却是通的，所以必须退让。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGithub, createStore, AppError } from './public/github-core.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
// 打包成 Electron 后程序目录在 app.asar 里（只读），所以数据目录必须可外部指定
const DATA_DIR = process.env.GUW_DATA_DIR ? path.resolve(process.env.GUW_DATA_DIR) : path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'repos.json');
const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 7321;
const HOST = process.env.HOST || '127.0.0.1';
const UA = 'github-update-watch/1.0';
const TIMEOUT_MS = 25000;
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';
const SEED = ['deepseek-ai/deepseek-harness', 'microsoft/vscode', 'facebook/react'];

// ---------------------------------------------------------------- Node 传输层
let transport = null;
function curlGet(url, headers, direct) {
  const args = ['-sS', '-L', '--max-time', String(Math.ceil(TIMEOUT_MS / 1000)), '-A', UA, '-w', '\\n%{http_code}'];
  if (direct) args.push('--noproxy', '*');
  for (const [k, v] of Object.entries(headers || {})) args.push('-H', `${k}: ${v}`);
  args.push(url);
  const r = spawnSync(CURL, args, { encoding: 'utf8', timeout: TIMEOUT_MS + 10000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw new Error(`curl spawn failed: ${r.error.message}`);
  const out = r.stdout || '';
  const nl = out.lastIndexOf('\n');
  const status = Number(out.slice(nl + 1).trim());
  const text = out.slice(0, nl);
  if (r.status !== 0 && !status) throw new Error(`curl exit ${r.status}: ${((r.stderr || '').trim().split('\n')[0] || '').slice(0, 140)}`);
  return { status, text };
}

export async function fetchText(url, headers = {}) {
  const names = ['fetch', 'curl-direct', 'curl-proxy'];
  const order = transport ? [transport, ...names.filter((n) => n !== transport)] : names;
  const errs = [];
  for (const name of order) {
    try {
      let res;
      if (name === 'fetch') {
        const r = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
        res = { status: r.status, text: await r.text() };
      } else {
        res = curlGet(url, headers, name === 'curl-direct');
      }
      transport = name;
      let body = null;
      try { body = JSON.parse(res.text); } catch { /* 非 JSON 也照常返回 */ }
      return { status: res.status, text: res.text, body };
    } catch (e) {
      errs.push(`${name}: ${e.message}`);
      transport = null;
    }
  }
  throw new Error(errs.join(' | '));
}
export const currentTransport = () => transport;

// ---------------------------------------------------------------- 存储
function load() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { return null; }
}
function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_FILE);   // 原子替换，避免写一半留个坏文件
}

const github = createGithub({ fetchText });
export const store = createStore({ github, load, save });
const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

export function createServer() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
    });
  }
  function serveStatic(req, res) {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(buf);
    });
  }

  return http.createServer(async (req, res) => {
    const p = new URL(req.url, `http://${req.headers.host || 'x'}`).pathname;
    try {
      if (!p.startsWith('/api/')) return serveStatic(req, res);

      if (req.method === 'GET' && p === '/api/ping') return sendJson(res, 200, { ok: true, mode: 'server' });
      if (req.method === 'GET' && p === '/api/state') {
        const rate = await github.rate(store.settings.token);
        return sendJson(res, 200, store.getState({ transport, rate }));
      }
      if (req.method === 'POST' && p === '/api/repos') {
        const body = await readBody(req);
        return sendJson(res, 201, await store.add(body?.input));
      }
      const m = /^\/api\/repos\/([^/]+)(?:\/(check|ack|reset|releases))?$/.exec(p);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const action = m[2];
        if (req.method === 'DELETE') { store.remove(id); return sendJson(res, 200, { ok: true }); }
        if (req.method === 'POST' && action === 'check') return sendJson(res, 200, await store.check(id));
        if (req.method === 'POST' && action === 'ack') return sendJson(res, 200, store.ack(id));
        if (req.method === 'POST' && action === 'reset') return sendJson(res, 200, store.reset(id));
        if (req.method === 'GET' && action === 'releases') return sendJson(res, 200, await store.releases(id));
      }
      if (req.method === 'POST' && p === '/api/check-all') {
        const started = store.repos.length;
        store.checkAll().catch(() => {});   // 后台跑，界面靠 /api/state 轮询 job
        return sendJson(res, 202, { started });
      }
      if (req.method === 'POST' && p === '/api/settings') {
        const body = await readBody(req);
        return sendJson(res, 200, store.setToken(body?.token));
      }
      return sendJson(res, 404, { error: `未知接口 ${req.method} ${p}` });
    } catch (e) {
      const msg = e?.message || String(e);
      const status = e instanceof AppError
        ? (e.rateLimited ? 429 : e.status === 404 ? 404 : /已经在列表/.test(msg) ? 409 : 400)
        : 500;
      return sendJson(res, status, { error: msg, rateLimited: !!(e instanceof AppError && e.rateLimited) });
    }
  });
}

// ---------------------------------------------------------------- 直接运行
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createServer();
  server.listen(PORT, HOST, async () => {
    console.log(`GitHub 更新监测已启动 → http://${HOST}:${PORT}/`);
    if (!load()) {
      console.log(`首次运行：加入 ${SEED.length} 个示例项目…`);
      await store.seed(SEED);
      console.log('示例项目已就绪（可在界面里删除）');
    }
  });
}

export { SEED, load, save };
