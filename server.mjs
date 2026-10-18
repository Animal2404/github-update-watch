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
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGithub, createStore, AppError } from './public/github-core.js';
import { createSecretStore, isEncrypted } from './secret.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
// 打包成 Electron 后程序目录在 app.asar 里（只读），所以数据目录必须可外部指定
const DATA_DIR = process.env.GUW_DATA_DIR ? path.resolve(process.env.GUW_DATA_DIR) : path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'repos.json');
// Token 落盘加密：密钥与数据同目录但分文件（0600）。
// 目标只是"repos.json 单独泄露/被备份带走时不暴露 Token"，不是系统钥匙串（见 secret.mjs 顶部）。
const KEY_FILE = path.join(DATA_DIR, '.token-key');
const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 7321;
const HOST = process.env.HOST || '127.0.0.1';
const UA = 'github-update-watch/1.0';
const TIMEOUT_MS = 25000;
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';
const SEED = ['deepseek-ai/deepseek-harness', 'microsoft/vscode', 'facebook/react'];

// ---------------------------------------------------------------- Node 传输层
let transport = null;
// 必须异步：spawnSync 会把 Node 单线程按住，curl 一慢（离线时最长 35s）所有 /api/* 请求一起卡住，
// 界面上的轮询就表现为"整个应用冻住"——网络问题被误读成 UI 卡死。
function curlGet(url, headers, direct) {
  return new Promise((resolve, reject) => {
    // 订阅额度在响应头 subscription-userinfo 里：curl 用 -D 落一个临时文件（-i 会和正文混在一起）
    const headerFile = path.join(os.tmpdir(), 'guw-h-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.txt');
    const args = ['-sS', '-L', '-D', headerFile, '--max-time', String(Math.ceil(TIMEOUT_MS / 1000)), '-A', UA, '-w', '\\n%{http_code}'];
    if (direct) args.push('--noproxy', '*');
    for (const [k, v] of Object.entries(headers || {})) args.push('-H', `${k}: ${v}`);
    args.push(url);
    const child = spawn(CURL, args, { windowsHide: true });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
      reject(new Error('curl 超时'));
    }, TIMEOUT_MS + 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.length > 32 * 1024 * 1024) { killed = true; child.kill(); }
    });
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`curl spawn failed: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let headersOut = {};
      try {
        const rawHeaders = fs.readFileSync(headerFile, 'utf8');
        const blocks = rawHeaders.split(/\r?\n\r?\n/).filter((b) => b.trim());
        const lastBlock = blocks[blocks.length - 1] || '';
        for (const line of lastBlock.split(/\r?\n/)) {
          const idx = line.indexOf(':');
          if (idx > 0) headersOut[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
      } catch { /* 没有 header 文件就按空处理 */ }
      try { fs.unlinkSync(headerFile); } catch { /* 忽略 */ }
      if (killed) return;                       // 超时/超限已经 reject 过
      const nl = out.lastIndexOf('\n');
      const status = Number(out.slice(nl + 1).trim());
      const text = out.slice(0, nl);
      if (code !== 0 && !status) return reject(new Error(`curl exit ${code}: ${(err.trim().split('\n')[0] || '').slice(0, 140)}`));
      resolve({ status, text, headers: headersOut });
    });
  });
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
        res = { status: r.status, text: await r.text(), headers: Object.fromEntries(r.headers.entries()) };
      } else {
        res = await curlGet(url, headers, name === 'curl-direct');
      }
      transport = name;
      let body = null;
      try { body = JSON.parse(res.text); } catch { /* 非 JSON 也照常返回 */ }
      return { status: res.status, text: res.text, body, headers: res.headers || {} };
    } catch (e) {
      errs.push(`${name}: ${e.message}`);
      transport = null;
    }
  }
  throw new Error(errs.join(' | '));
}
export const currentTransport = () => transport;

// ---------------------------------------------------------------- 存储
const secrets = createSecretStore({
  keyFile: KEY_FILE,
  warn: (msg) => console.warn('[secret] ' + msg),
});
let pendingTokenMigration = false;   // 读到旧版本的明文 Token 时置位，启动后立刻转成密文

function load() {
  let state;
  try { state = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { return null; }
  if (!state || typeof state !== 'object') return null;
  const token = state.settings && state.settings.token;
  if (typeof token === 'string' && token) {
    if (isEncrypted(token)) {
      const plain = secrets.decrypt(token);
      // 解不开（密钥丢了/换了机器）就当没填过，不要让整个应用起不来
      state.settings.token = plain === null ? '' : plain;
    } else {
      pendingTokenMigration = true;    // 0.1.0 之前留下的明文
    }
  }
  // 订阅链接同样是凭据：落盘密文，读盘解密
  if (Array.isArray(state.subscriptions)) {
    for (const sub of state.subscriptions) {
      if (!sub || typeof sub.url !== 'string' || !sub.url) continue;
      if (isEncrypted(sub.url)) {
        const plain = secrets.decrypt(sub.url);
        sub.url = plain === null ? '' : plain;
      } else {
        pendingTokenMigration = true;   // 旧数据里的明文，下一次 save 转密文
      }
    }
  }
  return state;
}
function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 内存里始终是明文（请求要用），落盘时统一加密；已经是密文的不会二次包装
  const out = { ...state, settings: { ...(state.settings || {}) } };
  if (out.settings.token) out.settings.token = secrets.encrypt(out.settings.token);
  if (Array.isArray(out.subscriptions)) {
    out.subscriptions = out.subscriptions.map((sub) => (
      sub && sub.url ? { ...sub, url: secrets.encrypt(sub.url) } : sub
    ));
  }
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows 上基本 no-op */ }
  fs.renameSync(tmp, STORE_FILE);   // 原子替换，避免写一半留个坏文件
}

const github = createGithub({ fetchText });
export const store = createStore({ github, load, save, fetchText });
// 明文 Token 迁移：一次写盘即完成，之后 load 读到的都是密文
if (pendingTokenMigration) {
  try {
    save({ repos: store.repos, subscriptions: store.subscriptions, settings: store.settings });
    pendingTokenMigration = false;
    console.log('[secret] 已把 repos.json 里的明文 Token 迁移为密文');
  } catch (e) {
    console.warn('[secret] Token 迁移失败（不影响本次运行）：' + e.message);
  }
}

// ---------------------------------------------------------------- Host 校验（DNS rebinding 防护）
// 只监听 127.0.0.1 并不能挡住 DNS rebinding：攻击者把自己的域名解析到 127.0.0.1，
// 浏览器就会以"同源"身份访问本机服务。校验 Host 头即可让这类请求 403。
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (HOST && HOST !== '0.0.0.0' && HOST !== '::') ALLOWED_HOSTS.add(HOST.toLowerCase());
export function hostnameOf(req) {
  const host = String(req.headers.host || '');
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (v6) return v6[1].toLowerCase();
  return host.replace(/:\d+$/, '').toLowerCase();
}
export function hostAllowed(req) {
  return ALLOWED_HOSTS.has(hostnameOf(req));
}
const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

export function createServer() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolve(value); } };
      req.on('data', (c) => {
        data += c;
        // 超限：先给调用方一个结果再断连接，否则 Promise 永远不 resolve（请求悬挂）
        if (data.length > 1e6) { finish(null); req.destroy(); }
      });
      req.on('end', () => { if (!done) { try { finish(data ? JSON.parse(data) : {}); } catch { finish(null); } } });
      req.on('error', () => finish(null));
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
    // Host 校验放在最前面：DNS rebinding 防护（详见 hostAllowed 上方注释）
    if (!hostAllowed(req)) {
      const isApi = String(req.url || '').startsWith('/api/');
      if (isApi) sendJson(res, 403, { error: `拒绝访问：Host "${hostnameOf(req)}" 不在允许列表` });
      else res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden host');
      return;
    }
    const p = new URL(req.url, `http://${req.headers.host || 'x'}`).pathname;
    try {
      if (!p.startsWith('/api/')) return serveStatic(req, res);

      if (req.method === 'GET' && p === '/api/ping') return sendJson(res, 200, { ok: true, mode: 'server' });
      if (req.method === 'GET' && p === '/api/rate') {
        return sendJson(res, 200, { rate: await github.rate(store.settings.token, { fresh: true }) });
      }
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
      if (req.method === 'POST' && p === '/api/subs') {
        const body = await readBody(req);
        return sendJson(res, 201, await store.addSubscription(body?.input, body?.name));
      }
      const sm = /^\/api\/subs\/([^/]+)(?:\/(refresh))?$/.exec(p);
      if (sm) {
        const sid = decodeURIComponent(sm[1]);
        const sa = sm[2];
        if (req.method === 'DELETE') { store.removeSubscription(sid); return sendJson(res, 200, { ok: true }); }
        if (req.method === 'POST' && sa === 'refresh') return sendJson(res, 200, await store.refreshSubscription(sid));
      }
      if (req.method === 'POST' && p === '/api/settings') {
        const body = await readBody(req);
        const tokenNote = body && 'token' in body ? store.setToken(body.token) : null;
        const modeNote = body && body.nodeQuotaMode ? store.setNodeQuotaMode(body.nodeQuotaMode) : null;
        return sendJson(res, 200, { ...(tokenNote || {}), ...(modeNote || {}), nodeQuotaMode: store.settings.nodeQuotaMode });
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
