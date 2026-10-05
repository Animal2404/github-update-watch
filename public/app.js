/**
 * GitHub 更新监测 · 前端
 * ---------------------------------------------------------------------------
 * 图标动效走 morphicons（本地 vendor，不依赖 CDN）：
 *   主题 sun↔moon、检查 refresh-cw↔loader-circle↔circle-check、
 *   版本历史 chevron-down↔chevron-up、添加 plus↔check、已读 check-check↔circle-check。
 * 图标是「数据」不是组件（icons.js 由 tools/build-icons.mjs 构建期生成并自检）。
 */
import { createMorph } from './vendor/morphicons/dom.js';
import { icons } from './vendor/icons.js';
import { createGithub, createStore } from './github-core.js';

// ---------------------------------------------------------------- 后端选择
// 桌面版：页面由 server.mjs 提供，走 /api/*（Node 侧有 curl 代理退让链 + 磁盘存储）
// 安卓 APK / 离线：没有服务端，直接用**同一份** github-core 调 api.github.com，数据存 localStorage。
// 两边检测逻辑是同一个模块，所以「手机和电脑功能一模一样」是结构保证，不是靠人工对齐。

const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status, rateLimited: data?.rateLimited });
  return data;
};

const httpBackend = {
  kind: 'server',
  label: '本机服务',
  state: () => api('/api/state'),
  add: (input) => api('/api/repos', { method: 'POST', body: { input } }),
  remove: (id) => api(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  check: (id) => api(`/api/repos/${encodeURIComponent(id)}/check`, { method: 'POST' }),
  ack: (id) => api(`/api/repos/${encodeURIComponent(id)}/ack`, { method: 'POST' }),
  releases: (id) => api(`/api/repos/${encodeURIComponent(id)}/releases`),
  checkAll: () => api('/api/check-all', { method: 'POST' }),
  setToken: (token) => api('/api/settings', { method: 'POST', body: { token } }),
};

const directBackend = (() => {
  const KEY = 'guw-store-v1';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 隐私模式可能写不了 */ } };
  const fetchText = async (url, headers) => {
    const r = await fetch(url, { headers, redirect: 'follow' });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 忽略 */ }
    return { status: r.status, text, body };
  };
  const github = createGithub({ fetchText });
  const store = createStore({ github, load, save });
  let rateCache = { at: 0, value: null };
  return {
    kind: 'direct',
    label: '直连模式',
    store,
    async state() {
      let rate = rateCache.value;
      if (Date.now() - rateCache.at > 3 * 60 * 1000) {   // 额度别每次轮询都问，否则把额度问没
        rate = await github.rate(store.settings.token);
        rateCache = { at: Date.now(), value: rate };
      }
      return store.getState({ transport: 'browser-direct', rate });
    },
    add: (input) => store.add(input),
    remove: (id) => store.remove(id),
    check: (id) => store.check(id),
    ack: (id) => store.ack(id),
    releases: (id) => store.releases(id),
    checkAll: async () => { store.checkAll().catch(() => {}); return { started: store.repos.length }; },
    setToken: (token) => store.setToken(token),
  };
})();

let backend = httpBackend;   // 启动时探测后确定

// ---------------------------------------------------------------- 系统通知
// 三端要一致：网页/桌面用 Web Notification；安卓 WebView 不支持 Web 通知，
// 由 MainActivity 注入的 AndroidNotify 桥走原生通知。开关存在 localStorage（每台设备各自决定）。
const NOTIFY_KEY = 'guw-notify';
const notifyEnabled = () => localStorage.getItem(NOTIFY_KEY) !== 'off';
const notifySupported = () => !!(window.AndroidNotify || typeof Notification !== 'undefined');

function setNotifyPref(on) {
  localStorage.setItem(NOTIFY_KEY, on ? 'on' : 'off');
  if (on && !window.AndroidNotify && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}
/** 检查完发现新版本时弹通知；返回是否真的弹出去了（测试要断言这个） */
function notifyUpdates(updates) {
  if (!notifyEnabled() || !updates.length) return false;
  const title = `GitHub 更新监测：${updates.length} 个项目有新版本`;
  const body = updates.slice(0, 4).map((r) => `${r.canonical || r.id} → ${r.latest?.tag}`).join('\n');
  if (window.AndroidNotify) {
    try { window.AndroidNotify.notify(title, body); return true; } catch { return false; }
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  try { new Notification(title, { body, tag: 'guw-updates' }); return true; } catch { return false; }
}

// ---------------------------------------------------------------- 图标
const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function bindIcon(svg, name) {
  const pathEl = svg.querySelector('path');
  if (!pathEl) return null;
  const m = createMorph(pathEl, icons[name], { reducedMotion: 'user' });
  svg._morph = m;
  svg._iconName = name;
  return m;
}
function morph(svg, name, spring) {
  if (!svg) return;
  if (!svg._morph) return void bindIcon(svg, name);
  if (svg._iconName === name) return;
  svg._iconName = name;
  svg._morph.morphTo(icons[name], spring || 'snappy');
}
/** 忙碌态：图标切成 loader 并让它转起来 */
function setBusy(svg, busy, restName) {
  if (!svg) return;
  if (busy) { morph(svg, 'loader-circle'); svg.classList.add('spin'); }
  else { svg.classList.remove('spin'); morph(svg, restName); }
}
function iconSvg(name, cls = 'icon') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path data-icon="${name}"></path></svg>`;
}
// 静态图标（含 HTML 里预置的 data-icon 占位）统一初始化
function initAllIcons(root = document) {
  for (const svg of root.querySelectorAll('svg > path[data-icon]')) {
    const name = svg.dataset.icon;
    if (icons[name] && !svg.parentElement._morph) bindIcon(svg.parentElement, name);
  }
}

// ---------------------------------------------------------------- 状态
const state = { repos: [], filter: 'all', query: '', job: null, hasToken: false, rate: null, transport: null, lastRunAt: null };
const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const emptyState = $('#emptyState');
const cards = new Map();      // id -> { el, sig }

// ---------------------------------------------------------------- Toast
function toast(message, kind = 'info', ms = 4200) {
  const box = document.createElement('div');
  box.className = 'toast';
  box.dataset.kind = kind;
  box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  box.innerHTML = `${iconSvg(kind === 'error' ? 'circle-alert' : kind === 'success' ? 'circle-check' : 'info', 'icon icon-sm')}<span></span>`;
  box.querySelector('span').textContent = message;
  $('#toasts').append(box);
  initAllIcons(box);
  setTimeout(() => { box.classList.add('is-out'); setTimeout(() => box.remove(), 220); }, ms);
}

// ---------------------------------------------------------------- 格式化
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return d.toLocaleDateString('zh-CN');
};
const fmtStars = (n) => (n == null ? null : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const STATUS = {
  update: { cls: 'badge-update', text: '有新版本', icon: 'arrow-up-right' },
  clean: { cls: 'badge-clean', text: '已是最新', icon: 'check' },
  'no-baseline': { cls: 'badge-warn', text: '待记录基线', icon: 'clock' },
  error: { cls: 'badge-error', text: '检查失败', icon: 'circle-alert' },
  unknown: { cls: 'badge-clean', text: '未知', icon: 'clock' },
};
const statusOf = (r) => (r.error ? 'error' : r.status);

// ---------------------------------------------------------------- 卡片
function cardSignature(r) {
  return JSON.stringify([r.status, r.error, r.baseline, r.latest?.tag, r.stars, r.description, r.lastCheckedAt, r.archived, r.canonical, r.renamedFrom, r.url]);
}
function createCard(r) {
  const el = document.createElement('article');
  el.className = 'card repo-card';
  el.dataset.id = r.id;
  el.innerHTML = `
    <div class="repo-head">
      ${iconSvg('folder-open', 'icon icon-lg')}
      <div class="repo-title">
        <h3><a href="${r.url}" target="_blank" rel="noreferrer noopener" data-testid="repo-link">${r.canonical || `${r.owner}/${r.repo}`}</a></h3>
        <div class="rename" data-field="rename" hidden></div>
      </div>
      <span class="badge" data-field="status"></span>
    </div>
    <p class="repo-desc" data-field="desc"></p>
    <div class="repo-meta" data-field="meta"></div>
    <div class="versions" data-field="versions"></div>
    <div class="repo-error" data-field="error" hidden></div>
    <div class="releases" data-field="releases" hidden></div>
    <div class="repo-actions">
      <button class="btn btn-sm btn-outline" type="button" data-action="check">
        ${iconSvg('refresh-cw', 'icon icon-sm')}<span>检查</span>
      </button>
      <button class="btn btn-sm btn-ghost" type="button" data-action="releases" aria-expanded="false">
        ${iconSvg('chevron-down', 'icon icon-sm')}<span>版本历史</span>
      </button>
      <button class="btn btn-sm btn-ghost" type="button" data-action="ack">
        ${iconSvg('check-check', 'icon icon-sm')}<span>标记已读</span>
      </button>
      <a class="btn btn-sm btn-ghost" data-action="release-link" target="_blank" rel="noreferrer noopener" hidden>
        ${iconSvg('external-link', 'icon icon-sm')}<span>Release</span>
      </a>
      <button class="btn btn-sm btn-ghost btn-icon" type="button" data-action="open-repo" aria-label="在浏览器打开仓库">
        ${iconSvg('arrow-up-right', 'icon icon-sm')}
      </button>
      <button class="btn btn-sm btn-danger btn-icon" type="button" data-action="delete" aria-label="删除项目">
        ${iconSvg('trash-2', 'icon icon-sm')}
      </button>
    </div>`;
  initAllIcons(el);
  updateCard(el, r, { fresh: true });
  return el;
}

function updateCard(el, r, { fresh = false } = {}) {
  el.dataset.status = statusOf(r);
  const st = STATUS[statusOf(r)] || STATUS.unknown;
  const badge = el.querySelector('[data-field="status"]');
  badge.className = `badge ${st.cls}`;
  badge.innerHTML = `${iconSvg(st.icon, 'icon icon-sm')}<span data-testid="status-text">${st.text}</span>`;
  initAllIcons(badge);

  // 仓库改名/迁移：标题用 GitHub 当前真名，另起一行说明原名，避免"名字对不上链接"的困惑
  const repoLink = el.querySelector('[data-testid="repo-link"]');
  const display = r.canonical || `${r.owner}/${r.repo}`;
  repoLink.textContent = display;
  repoLink.href = r.url;
  const renameEl = el.querySelector('[data-field="rename"]');
  const renamed = r.renamedFrom && r.renamedFrom.toLowerCase() !== display.toLowerCase();
  renameEl.hidden = !renamed;
  if (renamed) renameEl.textContent = `已迁移：原名 ${r.renamedFrom}`;
  const desc = el.querySelector('[data-field="desc"]');
  desc.hidden = !r.description;
  desc.textContent = r.description || '';

  const meta = [];
  if (r.archived) meta.push(`<span class="item" style="color:var(--warning)">${iconSvg('triangle-alert', 'icon icon-sm')}仓库已归档</span>`);
  if (r.stars != null) meta.push(`<span class="item">${iconSvg('star', 'icon icon-sm')}<span class="mono" data-testid="stars">${fmtStars(r.stars)}</span></span>`);
  if (r.latest?.publishedAt) meta.push(`<span class="item">${iconSvg('clock', 'icon icon-sm')}发布 ${fmtDate(r.latest.publishedAt)}</span>`);
  meta.push(`<span class="item">检查 ${fmtDate(r.lastCheckedAt)}</span>`);
  el.querySelector('[data-field="meta"]').innerHTML = meta.join('');
  initAllIcons(el.querySelector('[data-field="meta"]'));

  const versions = el.querySelector('[data-field="versions"]');
  if (r.baseline && r.latest) {
    const changed = statusOf(r) === 'update';
    // 没有更新时不画 "v1 → v1" 这种同值箭头（看着像有变化，其实是噪音）
    versions.innerHTML = changed
      ? `<span class="tag" data-testid="baseline">${r.baseline}</span><span class="arrow">→</span>
         <span class="tag tag-new" data-testid="latest">${r.latest.tag}</span>
         <span class="muted-note">新版本待确认</span>`
      : `<span class="tag" data-testid="baseline">${r.baseline}</span><span class="muted-note">已记录为基线</span>`;
  } else if (r.latest) {
    versions.innerHTML = `<span class="tag" data-testid="latest">${r.latest.tag}</span><span class="muted-note">未记录基线</span>`;
  } else {
    versions.innerHTML = '';
  }

  const err = el.querySelector('[data-field="error"]');
  err.hidden = !r.error;
  err.textContent = r.error || '';

  const ackBtn = el.querySelector('[data-action="ack"]');
  ackBtn.disabled = statusOf(r) !== 'update';
  ackBtn.title = ackBtn.disabled ? '当前没有待确认的新版本' : `把 ${r.latest?.tag || ''} 记为已读`;

  const link = el.querySelector('[data-action="release-link"]');
  if (r.latest?.url) { link.href = r.latest.url; link.hidden = false; } else { link.hidden = true; }

  if (fresh) el.style.animationDelay = `${Math.min(cards.size, 8) * 45}ms`;
}

function renderGrid() {
  // 首屏骨架屏用完必须清掉，否则会和真实卡片叠在一起（截图里露出来过）
  for (const sk of grid.querySelectorAll('.skeleton-card')) sk.remove();
  const q = state.query.trim().toLowerCase();
  const visible = state.repos.filter((r) => {
    const st = statusOf(r);
    if (state.filter === 'update' && st !== 'update') return false;
    if (state.filter === 'clean' && !(st === 'clean' || st === 'no-baseline')) return false;
    if (state.filter === 'error' && st !== 'error') return false;
    if (q && !(`${r.owner}/${r.repo} ${r.description || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });

  const seen = new Set();
  visible.forEach((r, i) => {
    seen.add(r.id);
    const sig = cardSignature(r);
    let entry = cards.get(r.id);
    if (!entry) {
      const el = createCard(r);
      entry = { el, sig };
      cards.set(r.id, entry);
      grid.append(el);
    } else if (entry.sig !== sig) {
      updateCard(entry.el, r);
      entry.sig = sig;
    }
    entry.el.style.order = String(i);
  });
  for (const [id, entry] of cards) if (!seen.has(id)) { entry.el.remove(); cards.delete(id); }

  const total = state.repos.length;
  const counts = { all: total, update: 0, clean: 0, error: 0 };
  for (const r of state.repos) {
    const st = statusOf(r);
    if (st === 'update') counts.update++;
    else if (st === 'error') counts.error++;
    else counts.clean++;
  }
  $('#countAll').textContent = counts.all;
  $('#countUpdate').textContent = counts.update;
  $('#countClean').textContent = counts.clean;
  $('#countError').textContent = counts.error;

  const noMatch = total > 0 && visible.length === 0;
  emptyState.hidden = total > 0;
  if (noMatch) {
    emptyState.hidden = false;
    $('#emptyTitle').textContent = '没有匹配的项目';
    $('#emptyText').textContent = '换个关键词，或把过滤器切回「全部」。';
  } else if (total === 0) {
    $('#emptyTitle').textContent = '还没有监测任何项目';
    $('#emptyText').textContent = '在上面粘贴一个 GitHub 链接开始吧。添加后它会记录当前最新版本作为基线，之后每次检查都会告诉你有没有新版本。';
  }
  grid.setAttribute('aria-busy', 'false');
  $('#lastRunLine').textContent = state.lastRunAt ? `上次整体检查：${fmtDate(state.lastRunAt)}` : '尚未整体检查过（自动检查按需触发）';
}

function renderHeader() {
  const badge = $('#rateBadge');
  if (state.rate) {
    badge.textContent = `额度 ${state.rate.remaining}/${state.rate.limit}`;
    badge.className = `badge badge-mono ${state.rate.remaining > 10 ? 'badge-clean' : 'badge-warn'}`;
    badge.title = `GitHub API 剩余 ${state.rate.remaining}/${state.rate.limit}（${state.hasToken ? '已用 Token' : '未认证'}）${state.transport ? ` · 通道 ${state.transport}` : ''}`;
  } else {
    badge.textContent = state.hasToken ? '额度 —' : '未认证';
    badge.title = '拿不到额度信息（可能是网络或限流）';
  }
}

function renderJob() {
  const job = state.job;
  const btn = $('#checkAllBtn');
  const label = $('#checkAllLabel');
  const status = $('#jobStatus');
  const svg = btn.querySelector('svg');
  if (job?.running) {
    btn.disabled = true;
    label.textContent = `检查中 ${job.done}/${job.total}`;
    setBusy(svg, true);
    status.textContent = job.current ? `正在检查 ${job.current}…` : `检查中 ${job.done}/${job.total}`;
  } else {
    btn.disabled = state.repos.length === 0;
    label.textContent = '全部检查';
    setBusy(svg, false, 'refresh-cw');
    status.textContent = job ? `完成：${job.done} 个，失败 ${job.failed} 个` : '';
  }
}

async function refresh({ quiet = false } = {}) {
  try {
    const data = await backend.state();
    state.repos = data.repos || [];
    state.job = data.job || null;
    state.hasToken = !!data.hasToken;
    state.rate = data.rate || null;
    state.transport = data.transport || null;
    state.lastRunAt = data.lastRunAt || null;
    renderGrid(); renderHeader(); renderJob();
    return data;
  } catch (e) {
    if (!quiet) toast(`读取状态失败：${e.message}`, 'error');
    grid.setAttribute('aria-busy', 'false');
    throw e;
  }
}

// ---------------------------------------------------------------- 交互：添加
$('#addForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#repoInput');
  const btn = $('#addBtn');
  const hint = $('#repoHint');
  const value = input.value.trim();
  if (!value) {
    hint.className = 'hint is-error';
    hint.textContent = '请先填一个 GitHub 链接或 owner/repo。';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  const svg = btn.querySelector('svg');
  btn.disabled = true;
  setBusy(svg, true);                    // loader-circle + 旋转
  let ok = false;
  try {
    const res = await backend.add(value);
    ok = true;
    input.value = '';
    input.removeAttribute('aria-invalid');
    hint.className = 'hint';
    hint.innerHTML = '支持完整链接、<code>owner/repo</code>、<code>git@github.com:owner/repo.git</code>；添加时会把当前最新版本记为基线。';
    toast(res.note || '已添加', res.repo?.error ? 'error' : 'success');
    await refresh({ quiet: true });
  } catch (e) {
    hint.className = 'hint is-error';
    hint.textContent = e.message;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    // .spin 只有 setBusy 能摘掉。这里以前写成 `if (!classList.contains('spin'))`，
    // 条件正好反了 —— 忙的时候不清理，于是图标永远转下去（用户看到的"叉叉一直旋转"）。
    setBusy(svg, false, ok ? 'check' : 'circle-alert');
    setTimeout(() => morph(svg, 'plus'), ok ? 1400 : 1800);
  }
});

// ---------------------------------------------------------------- 交互：全部检查（带轮询）
let pollTimer = null;
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
$('#checkAllBtn').addEventListener('click', async () => {
  try {
    await backend.checkAll();
    state.job = { running: true, done: 0, total: state.repos.length, failed: 0 };
    renderJob();
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        await refresh({ quiet: true });
        if (!state.job?.running) {
          stopPolling();
          const updates = state.repos.filter((r) => statusOf(r) === 'update');
          const notified = notifyUpdates(updates);
          toast(state.job?.failed ? `检查完成，${state.job.failed} 个失败` : `检查完成：${updates.length} 个有新版本${notified ? '（已发系统通知）' : ''}`, state.job?.failed ? 'error' : updates.length ? 'success' : 'info');
        }
      } catch { stopPolling(); }
    }, 700);
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ---------------------------------------------------------------- 交互：卡片按钮（事件委托）
grid.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const card = ev.target.closest('.repo-card');
  const id = card?.dataset.id;
  const repo = state.repos.find((r) => r.id === id);
  if (!repo) return;
  const action = btn.dataset.action;
  const svg = btn.querySelector('svg');

  if (action === 'open-repo') { window.open(repo.url, '_blank', 'noopener'); return; }

  if (action === 'delete') {
    const ok = await confirmDialog(`确定要从监测列表里移除 <strong>${repo.owner}/${repo.repo}</strong> 吗？`);
    if (!ok) return;
    try {
      await backend.remove(id);
      toast(`已移除 ${repo.owner}/${repo.repo}`, 'success');
      await refresh({ quiet: true });
    } catch (e) { toast(e.message, 'error'); }
    return;
  }

  if (action === 'releases') {
    const box = card.querySelector('[data-field="releases"]');
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    if (expanded) {
      btn.setAttribute('aria-expanded', 'false');
      morph(svg, 'chevron-down');
      box.hidden = true;
      return;
    }
    btn.setAttribute('aria-expanded', 'true');
    morph(svg, 'chevron-up');
    box.hidden = false;
    box.innerHTML = `<div class="release-item"><span class="name">加载中…</span></div>`;
    try {
      const { releases } = await backend.releases(id);
      if (!releases.length) { box.innerHTML = `<div class="release-item"><span class="name">这个仓库还没有发布任何 Release</span></div>`; return; }
      // Release 的 name 经常就等于 tag（GitHub 自动生成），重复显示纯属噪音 —— 相同就不显示
      const stripV = (s) => String(s || '').replace(/^v/i, '').toLowerCase();
      box.innerHTML = releases.map((r) => {
        const name = (r.name || '').trim();
        const showName = name && stripV(name) !== stripV(r.tag);
        return `
        <div class="release-item">
          <span class="tag ${r.tag === repo.latest?.tag ? 'tag-new' : ''}">${r.tag}</span>
          ${showName
            ? `<a class="name" href="${r.url}" target="_blank" rel="noreferrer noopener" title="${name.replace(/"/g, '&quot;')}">${name.slice(0, 42)}</a>`
            : `<span class="name"></span>`}
          <span class="date">${fmtDate(r.publishedAt)}</span>
        </div>`;
      }).join('');
    } catch (e) {
      box.innerHTML = `<div class="release-item"><span class="name" style="color:var(--destructive)">加载失败：${e.message}</span></div>`;
    }
    return;
  }

  // check / ack
  btn.disabled = true;
  setBusy(svg, true);
  try {
    const res = action === 'check' ? await backend.check(id) : await backend.ack(id);
    toast(res.note || '完成', res.repo?.error ? 'error' : action === 'check' && statusOf(res.repo) === 'update' ? 'success' : 'info');
    setBusy(svg, false, action === 'ack' ? 'check-check' : 'refresh-cw');
    if (action === 'check') { morph(svg, res.repo?.error ? 'circle-alert' : 'circle-check'); }
    await refresh({ quiet: true });
    setTimeout(() => morph(svg, action === 'ack' ? 'check-check' : 'refresh-cw'), 1500);
  } catch (e) {
    toast(e.message, 'error');
    setBusy(svg, false, action === 'ack' ? 'check-check' : 'refresh-cw');
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- 交互：过滤 / 搜索
document.querySelectorAll('.chip[data-filter]').forEach((chip) => {
  chip.addEventListener('click', () => {
    state.filter = chip.dataset.filter;
    document.querySelectorAll('.chip[data-filter]').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    renderGrid();
  });
});
let searchTimer = null;
$('#searchInput').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  const v = ev.target.value;
  searchTimer = setTimeout(() => { state.query = v; renderGrid(); }, 120);
});

// ---------------------------------------------------------------- 交互：主题
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('guw-theme', theme);
  morph($('#themeBtn').querySelector('svg'), theme === 'dark' ? 'moon' : 'sun');
}
$('#themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// ---------------------------------------------------------------- 交互：设置对话框
const settingsDialog = $('#settingsDialog');
const confirmEl = $('#confirmDialog');
let confirmResolve = null;

$('#settingsBtn').addEventListener('click', () => {
  $('#tokenInput').value = '';
  $('#rateHint').textContent = (state.rate
    ? `当前额度：${state.rate.remaining}/${state.rate.limit}（${state.hasToken ? '已用 Token' : '未认证，60 次/小时'}）`
    : '拿不到额度信息，可能是网络问题。') + ` · 模式：${backend.label}${state.transport ? `（${state.transport}）` : ''}`;
  const toggle = $('#notifyToggle');
  toggle.checked = notifyEnabled();
  toggle.disabled = !notifySupported();
  toggle.closest('.switch-row').title = notifySupported() ? '' : '当前环境不支持系统通知';
  // 版本号：出问题时先问"你装的是哪个版本"，比让人翻文件属性靠谱
  $('#verText').textContent = window.__GUW_VERSION || '未知';
  settingsDialog.showModal();
});

$('#notifyToggle').addEventListener('change', (ev) => {
  setNotifyPref(ev.target.checked);
  toast(ev.target.checked ? '已开启：发现新版本时弹系统通知' : '已关闭系统通知', 'info');
});
$('#settingsCloseBtn').addEventListener('click', () => settingsDialog.close());
$('#tokenSaveBtn').addEventListener('click', async () => {
  try {
    const res = await backend.setToken($('#tokenInput').value);
    toast(res.note, 'success');
    settingsDialog.close();
    await refresh({ quiet: true });
  } catch (e) { toast(e.message, 'error'); }
});
$('#tokenClearBtn').addEventListener('click', async () => {
  try {
    await backend.setToken('');
    $('#tokenInput').value = '';
    toast('Token 已清除', 'success');
    await refresh({ quiet: true });
  } catch (e) { toast(e.message, 'error'); }
});
settingsDialog.addEventListener('click', (ev) => { if (ev.target === settingsDialog) settingsDialog.close(); });

// ---------------------------------------------------------------- 确认对话框
function confirmDialog(html) {
  $('#confirmText').innerHTML = html;
  confirmEl.showModal();
  return new Promise((resolve) => { confirmResolve = resolve; });
}
$('#confirmCancelBtn').addEventListener('click', () => { confirmEl.close(); confirmResolve?.(false); confirmResolve = null; });
$('#confirmOkBtn').addEventListener('click', () => { confirmEl.close(); confirmResolve?.(true); confirmResolve = null; });
confirmEl.addEventListener('cancel', (ev) => { ev.preventDefault(); confirmEl.close(); confirmResolve?.(false); confirmResolve = null; });

// ---------------------------------------------------------------- 启动
(async function boot() {
  initAllIcons();
  applyTheme(localStorage.getItem('guw-theme') || 'dark');
  // 骨架屏：等待首次数据
  grid.innerHTML = Array.from({ length: 3 }, () => `
    <div class="card skeleton-card" aria-hidden="true">
      <div class="skeleton title"></div><div class="skeleton line"></div>
      <div class="skeleton line short"></div><div class="skeleton line" style="width:70%"></div>
    </div>`).join('');

  // 后端探测：APK 会带 ?mode=direct（页面来自 appassets，没有服务端）；
  // 其它情况在 http(s) 下先问本机服务，问不到就降级直连
  const forcedDirect = new URLSearchParams(location.search).get('mode') === 'direct';
  if (forcedDirect || !location.protocol.startsWith('http')) {
    backend = directBackend;
  } else {
    try {
      const r = await fetch('/api/ping');
      if (!r.ok || !(await r.json())?.ok) backend = directBackend;
    } catch { backend = directBackend; }
  }

  try {
    await refresh({ quiet: true });
  } catch (e) {
    grid.innerHTML = '';
    emptyState.hidden = false;
    $('#emptyTitle').textContent = backend.kind === 'server' ? '连不上本地服务' : '读取本地数据失败';
    $('#emptyText').textContent = backend.kind === 'server'
      ? `${e.message} —— 请确认 server.mjs 还在运行（重新双击 start.cmd）。`
      : e.message;
  }
  // 页面重新可见时刷新一次（服务端可能已被别的操作改动）
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.job?.running) refresh({ quiet: true }).catch(() => {}); });
})();

// 供自动化验证脚本读取内部状态的测试钩子（只读，不改变行为）
window.__guw = {
  get state() { return { repos: state.repos, filter: state.filter, query: state.query, job: state.job, hasToken: state.hasToken, transport: state.transport, theme: document.documentElement.dataset.theme, backend: backend.kind }; },
  icons,
};
