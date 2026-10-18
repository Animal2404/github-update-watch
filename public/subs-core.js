/**
 * 节点订阅 · 共享核心（不碰 DOM、不碰 Node API）
 * ---------------------------------------------------------------------------
 * 做三件事，且全部是可单测的纯函数：
 *   1. 解析订阅响应头 `subscription-userinfo` → 流量额度（upload/download/total/expire）
 *   2. 解析订阅正文（base64 节点列表 / Clash YAML）→ 节点数量、协议分布、名称
 *   3. 生成给界面用的只读视图（额度百分比、剩余、到期天数、脱敏链接）
 *
 * 边界说明（很重要）：
 *   · 额度是**按订阅**的流量池，来自响应头；不是"每个节点多少额度"。
 *   · 节点健康（延迟/可用）只能靠真实的 mihomo 外部控制器测，本模块不臆造。
 *   · 订阅链接本身是凭据：对外只暴露脱敏形式，完整 URL 留在存储层。
 */

/** 很多机场只在 Clash 系 UA 下才返回 subscription-userinfo */
export const SUB_UA = 'clash.meta/1.19.7';

const NODE_SCHEMES = ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'hy2', 'tuic', 'wireguard', 'socks', 'socks5', 'http', 'https'];

/** FNV-1a：给订阅一个稳定短 id（同一链接永远同一 id） */
export function subId(url) {
  let h = 0x811c9dc5;
  const s = String(url || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'sub-' + h.toString(16).padStart(8, '0');
}

export function normalizeSubUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('请先填一个订阅链接');
  if (raw.length > 4096) throw new Error('链接过长');
  let u;
  try { u = new URL(raw); } catch { throw new Error('不是合法的 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http(s) 订阅链接');
  return u.href;
}

/** 只显示协议 + 主机 + 4 位指纹，路径/Token 一律不露出 */
export function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/••••${subId(url).slice(-4)}`;
  } catch {
    return '••••';
  }
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

/** 响应头大小写不敏感地取值 */
export function headerValue(headers, name) {
  if (!headers) return '';
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) return String(headers[key] ?? '');
  }
  return '';
}

/**
 * 解析 `subscription-userinfo: upload=1; download=2; total=3; expire=1700000000`
 * 返回 null 表示机场没给额度信息（不臆造 0）。
 */
export function parseUserInfo(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const out = {};
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const num = Number(part.slice(eq + 1).trim());
    if (!Number.isFinite(num)) continue;
    out[key] = num;
  }
  if (!('total' in out)) return null;
  return {
    upload: Math.max(0, out.upload || 0),
    download: Math.max(0, out.download || 0),
    total: Math.max(0, out.total || 0),
    expire: Math.max(0, out.expire || 0),
  };
}

/** 给界面用的额度视图；now 可注入，方便测试 */
export function quotaView(quota, now = Date.now()) {
  if (!quota) return null;
  const used = (quota.upload || 0) + (quota.download || 0);
  const total = quota.total || 0;
  const unlimited = total <= 0;
  const percent = unlimited ? null : Math.min(100, Math.round((used / total) * 1000) / 10);
  const remaining = unlimited ? null : Math.max(0, total - used);
  const expireMs = quota.expire ? quota.expire * 1000 : 0;
  return {
    used,
    total,
    remaining,
    percent,
    unlimited,
    expireAt: expireMs ? new Date(expireMs).toISOString() : null,
    daysLeft: expireMs ? Math.ceil((expireMs - now) / 86400000) : null,
    expired: expireMs ? expireMs < now : false,
  };
}

function b64ToUtf8(input) {
  const clean = String(input).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function unquote(value) {
  const v = String(value ?? '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/** 解析普通机场的 base64 节点列表（ss:// vmess:// …） */
function parseUriList(text) {
  const nodes = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const m = /^([a-z0-9]+):\/\//i.exec(s);
    if (!m || !NODE_SCHEMES.includes(m[1].toLowerCase())) continue;
    const hash = s.indexOf('#');
    let name = '';
    if (hash >= 0) { try { name = decodeURIComponent(s.slice(hash + 1)); } catch { name = s.slice(hash + 1); } }
    nodes.push({ name: name || `节点 ${nodes.length + 1}`, type: m[1].toLowerCase() });
  }
  return nodes;
}

/**
 * 解析 Clash/mihomo YAML 的 proxies 段。
 * 只做"够用"的解析（name/type），不试图实现完整 YAML：
 *   · 流式：- { name: "x", type: ss, server: ... }
 *   · 块式：- name: x\n    type: ss\n    server: ...
 * 遇到下一个顶层键就停。
 */
function parseClashProxies(text) {
  const nodes = [];
  const lines = String(text).split(/\r?\n/);
  let inProxies = false;
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!inProxies) {
      if (/^proxies:\s*$/.test(line.trim())) inProxies = true;
      continue;
    }
    if (/^[A-Za-z_-][\w-]*:\s*$/.test(line) || /^[A-Za-z_-][\w-]*:\s+\S/.test(line)) break;   // 下一个顶层键
    const flow = /^\s*-\s*\{(.+)\}\s*$/.exec(line);
    if (flow) {
      const body = flow[1];
      const nameM = /(?:^|[,{])\s*name\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^']*)'|[^,}]+)/.exec(body);
      const typeM = /(?:^|[,{])\s*type\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^']*)'|[^,}]+)/.exec(body);
      if (nameM) nodes.push({ name: unquote(nameM[1]), type: unquote(typeM ? typeM[1] : '').toLowerCase() || 'unknown' });
      continue;
    }
    const dashName = /^\s*-\s*name\s*:\s*(.+)$/.exec(line);
    if (dashName) {
      current = { name: unquote(dashName[1]), type: 'unknown' };
      nodes.push(current);
      continue;
    }
    const typeLine = /^\s*type\s*:\s*(.+)$/.exec(line);
    if (typeLine && current) current.type = unquote(typeLine[1]).toLowerCase();
    if (/^\s*-\s*\S/.test(line) && !dashName) current = null;
  }
  return nodes.filter((n) => n.name && !/^(DIRECT|REJECT|GLOBAL|PASS)$/i.test(n.name));
}

function summarize(nodes, format) {
  const protocols = {};
  for (const n of nodes) protocols[n.type || 'unknown'] = (protocols[n.type || 'unknown'] || 0) + 1;
  return { format, count: nodes.length, protocols, nodes };
}

/** 自动识别 base64 / Clash YAML，返回 { format, count, protocols, nodes } */
export function parseSubscriptionBody(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) return summarize([], 'empty');
  if (/(^|\n)\s*proxies\s*:/.test(text)) return summarize(parseClashProxies(text), 'clash');
  let decoded = text;
  if (!/^[a-z0-9]+:\/\//im.test(text)) {
    try {
      const candidate = b64ToUtf8(text);
      if (/^[a-z0-9]+:\/\//im.test(candidate) || /(^|\n)\s*proxies\s*:/.test(candidate)) decoded = candidate;
    } catch { /* 不是 base64，保持原文 */ }
  }
  if (/(^|\n)\s*proxies\s*:/.test(decoded)) return summarize(parseClashProxies(decoded), 'clash');
  const nodes = parseUriList(decoded);
  return summarize(nodes, nodes.length ? 'uri' : 'unknown');
}

/**
 * 通过注入的 fetchText 拉订阅。返回 { quota, format, count, protocols, nodes }。
 * fetchText 由宿主注入（Node 侧带代理退让链；浏览器侧就是 fetch）。
 */
export async function fetchSubscription(fetchText, url) {
  const res = await fetchText(url, { 'user-agent': SUB_UA, accept: '*/*' });
  if (!res || typeof res.status !== 'number') throw new Error('订阅请求失败');
  if (res.status < 200 || res.status >= 300) throw new Error(`订阅返回 HTTP ${res.status}`);
  const text = String(res.text ?? '');
  if (text.length > 2 * 1024 * 1024) throw new Error('订阅内容过大（>2MB），已拒绝');
  const headers = res.headers || {};
  const quota = parseUserInfo(headerValue(headers, 'subscription-userinfo'));
  const parsed = parseSubscriptionBody(text);
  return { quota, ...parsed };
}

/** 存进存储层的记录 → 给界面的只读视图（永远不含完整 URL） */
export function publicSubscription(rec) {
  return {
    id: rec.id,
    name: rec.name || hostOf(rec.url) || '未命名订阅',
    host: hostOf(rec.url),
    maskedUrl: maskUrl(rec.url),
    addedAt: rec.addedAt || null,
    lastCheckedAt: rec.lastCheckedAt || null,
    error: rec.error || null,
    format: rec.format || null,
    quota: quotaView(rec.quota),
    nodes: rec.nodes || { count: 0, protocols: {}, nodes: [] },
  };
}
