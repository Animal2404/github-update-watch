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
import { createGithub, createStore, esc } from './github-core.js';

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
  rate: () => api('/api/rate'),
  add: (input) => api('/api/repos', { method: 'POST', body: { input } }),
  remove: (id) => api(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  check: (id) => api(`/api/repos/${encodeURIComponent(id)}/check`, { method: 'POST' }),
  ack: (id) => api(`/api/repos/${encodeURIComponent(id)}/ack`, { method: 'POST' }),
  reset: (id) => api(`/api/repos/${encodeURIComponent(id)}/reset`, { method: 'POST' }),
  releases: (id) => api(`/api/repos/${encodeURIComponent(id)}/releases`),
  checkAll: () => api('/api/check-all', { method: 'POST' }),
  addSub: (input, name) => api('/api/subs', { method: 'POST', body: { input, name } }),
  refreshSub: (id) => api('/api/subs/' + encodeURIComponent(id) + '/refresh', { method: 'POST' }),
  removeSub: (id) => api('/api/subs/' + encodeURIComponent(id), { method: 'DELETE' }),
  setToken: (token) => api('/api/settings', { method: 'POST', body: { token } }),
  setNodeQuotaMode: (mode) => api('/api/settings', { method: 'POST', body: { nodeQuotaMode: mode } }),
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
    return { status: r.status, text, body, headers: Object.fromEntries(r.headers.entries()) };
  };
  // Android WebView 里第三方订阅站不给 CORS，额度头也不在 exposed headers；
  // 有原生桥时订阅请求走原生（原生能读 status/headers/body），网页只负责解析。
  const androidFetch = (() => {
    if (!window.AndroidHttp) return null;
    var seq = 0;
    var pending = new Map();
    window.__androidHttp = function (id, payload) {
      var entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (payload && payload.error) entry.reject(new Error(payload.error));
      else entry.resolve({ status: payload.status, text: payload.text, headers: payload.headers || {}, body: null });
    };
    return function (url, headers) {
      return new Promise(function (resolve, reject) {
        var id = 'h' + (++seq) + '-' + Date.now();
        var timer = setTimeout(function () { pending.delete(id); reject(new Error('请求超时（20 秒）')); }, 20000);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        try { window.AndroidHttp.fetch(id, url, JSON.stringify(headers || {})); }
        catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
      });
    };
  })();
  const github = createGithub({ fetchText });
  const store = createStore({ github, load, save, fetchText, subscriptionFetch: androidFetch || fetchText });
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
    rate: async () => ({ rate: await github.rate(store.settings.token, { fresh: true }) }),
    add: (input) => store.add(input),
    remove: (id) => store.remove(id),
    check: (id) => store.check(id),
    ack: (id) => store.ack(id),
    reset: (id) => store.reset(id),
    releases: (id) => store.releases(id),
    checkAll: async () => { store.checkAll().catch(() => {}); return { started: store.repos.length }; },
    addSub: (input, name) => store.addSubscription(input, name),
    refreshSub: (id) => store.refreshSubscription(id),
    removeSub: (id) => store.removeSubscription(id),
    setToken: (token) => store.setToken(token),
    setNodeQuotaMode: (mode) => store.setNodeQuotaMode(mode),
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
const state = { repos: [], subscriptions: [], filter: 'all', query: '', job: null, hasToken: false, rate: null, transport: null, lastRunAt: null, nodeSort: 'name' };
const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const emptyState = $('#emptyState');
const cards = new Map();      // id -> { el, sig }

// 分段过滤器的滑块：位置永远由「当前选中的 chip」实测决定。
// 不能写死索引——四个 chip 宽度不同，字体加载完成后还会变（只量一次就会错位）。
const filtersEl = document.querySelector('.filters');
function updateFilterThumb() {
  if (!filtersEl) return;
  const active = filtersEl.querySelector('.chip[aria-pressed="true"]');
  if (!active) return;
  filtersEl.style.setProperty('--thumb-x', active.offsetLeft + 'px');
  filtersEl.style.setProperty('--thumb-w', active.offsetWidth + 'px');
}

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
  return JSON.stringify([r.status, r.error, r.baseline, r.latest?.tag, r.latest?.url, r.releaseSource, r.stars, r.description, r.lastCheckedAt, r.archived, r.canonical, r.renamedFrom, r.url]);
}
function createCard(r) {
  const el = document.createElement('article');
  el.className = 'card repo-card';
  el.dataset.id = r.id;
  el.innerHTML = `
    <div class="repo-head">
      ${iconSvg('folder-open', 'icon icon-lg')}
      <div class="repo-title">
        <h3><a href="${esc(r.url)}" target="_blank" rel="noreferrer noopener" data-testid="repo-link">${esc(r.canonical || `${r.owner}/${r.repo}`)}</a></h3>
        <div class="rename" data-field="rename" hidden></div>
      </div>
      <span class="badge" data-field="status"></span>
    </div>
    <p class="repo-desc" data-field="desc"></p>
    <div class="repo-meta" data-field="meta"></div>
    <div class="versions" data-field="versions"></div>
    <div class="repo-error" data-field="error" hidden></div>
    <div class="releases-window" data-field="releases" hidden>
      <div class="releases-scroll" data-field="releases-scroll" tabindex="0" role="region" aria-label="最近版本"></div>
      <div class="releases-hint"><span data-field="release-count"></span><span>滚轮 / 滑动看更早</span></div>
    </div>
    <!-- 一行动作：主操作在左，低频/危险操作收进右侧「⋯」，卡片里不再挤六个按钮 -->
    <div class="repo-actions">
      <div class="actions-left">
        <button class="btn btn-sm btn-outline" type="button" data-action="check">
          ${iconSvg('refresh-cw', 'icon icon-sm')}<span>检查</span>
        </button>
        <button class="btn btn-sm btn-ghost btn-ack" type="button" data-action="ack" hidden>
          ${iconSvg('check-check', 'icon icon-sm')}<span>标记已读</span>
        </button>
      </div>
      <div class="actions-right">
        <div class="menu-wrap">
          <button class="btn btn-sm btn-ghost btn-icon" type="button" data-action="menu"
                  aria-haspopup="menu" aria-expanded="false" aria-label="更多操作" title="更多操作">
            ${iconSvg('ellipsis', 'icon icon-sm')}
          </button>
          <div class="menu" data-field="menu" role="menu" aria-label="更多操作" hidden>
            <a class="menu-item" role="menuitem" data-action="release-link" target="_blank" rel="noreferrer noopener" hidden>
              ${iconSvg('external-link', 'icon icon-sm')}<span data-field="release-label">打开最新版本</span>
            </a>
            <button class="menu-item" role="menuitem" type="button" data-action="open-repo">
              ${iconSvg('arrow-up-right', 'icon icon-sm')}<span>在浏览器打开仓库</span>
            </button>
            <button class="menu-item" role="menuitem" type="button" data-action="reset">
              ${iconSvg('rotate-ccw', 'icon icon-sm')}<span>重置基线</span>
            </button>
            <div class="menu-sep" role="separator"></div>
            <button class="menu-item menu-item-danger" role="menuitem" type="button" data-action="delete">
              ${iconSvg('trash-2', 'icon icon-sm')}<span>删除项目</span>
            </button>
          </div>
        </div>
      </div>
    </div>`;
  initAllIcons(el);
  updateCard(el, r, { fresh: true });
  hydrateReleases(el);
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
  if (r.archived) meta.push(`<span class="item archived">${iconSvg('triangle-alert', 'icon icon-sm')}仓库已归档</span>`);
  if (r.stars != null) meta.push(`<span class="item">${iconSvg('star', 'icon icon-sm')}<span class="mono" data-testid="stars">${fmtStars(r.stars)}</span></span>`);
  if (r.latest?.publishedAt) meta.push(`<span class="item">${iconSvg('clock', 'icon icon-sm')}发布 ${fmtDate(r.latest.publishedAt)}</span>`);
  meta.push(`<span class="item">检查 ${fmtDate(r.lastCheckedAt)}</span>`);
  // 版本来源：只有 tags 兜底才值得一提（说明仓库没有正式 Release），不刷"releases"这种默认值
  if (r.releaseSource === 'tags') meta.push(`<span class="item source" title="该仓库没有正式 Release，版本取自 git tag">tag 兜底</span>`);
  el.querySelector('[data-field="meta"]').innerHTML = meta.join('');
  initAllIcons(el.querySelector('[data-field="meta"]'));

  const versions = el.querySelector('[data-field="versions"]');
  const latestUrl = r.latest?.url || '';
  const sourceName = r.releaseSource === 'tags' ? 'Tag' : 'Release';
  // 版本号本身就是最自然的入口：点最新版本 = 打开那一版。不用再额外占一个 "Release" 按钮的位置。
  const latestHtml = (extraCls) => latestUrl
    ? `<a class="tag tag-link ${extraCls}" data-testid="latest" href="${esc(latestUrl)}" target="_blank" rel="noreferrer noopener" title="打开最新 ${sourceName} 页">${esc(r.latest.tag)}</a>`
    : `<span class="tag ${extraCls}" data-testid="latest">${esc(r.latest.tag)}</span>`;
  if (r.baseline && r.latest) {
    // 用记录里的状态（r.status）而不是 statusOf：一次检查失败不该把"有新版本"的箭头藏起来，
    // 那会让卡片同时出现「检查失败」和「已是最新」两个互相矛盾的说法。
    const changed = r.status === 'update';
    versions.innerHTML = changed
      ? `<span class="tag" data-testid="baseline">${esc(r.baseline)}</span><span class="arrow" aria-hidden="true">→</span>${latestHtml('tag-new')}<span class="muted-note">待确认</span>`
      : `<span class="tag" data-testid="baseline">${esc(r.baseline)}</span><span class="muted-note">已是最新</span>`;
  } else if (r.latest) {
    versions.innerHTML = `${latestHtml('')}<span class="muted-note">未记录基线</span>`;
  } else {
    versions.innerHTML = '';
  }

  const err = el.querySelector('[data-field="error"]');
  err.hidden = !r.error;
  err.textContent = r.error || '';

  // 「标记已读」只在真的有新版本时出现：没更新时它本来就是禁用态，留着只是噪音
  const ackBtn = el.querySelector('[data-action="ack"]');
  const canAck = statusOf(r) === 'update';
  ackBtn.hidden = !canAck;
  ackBtn.disabled = !canAck;
  ackBtn.title = canAck ? `把 ${r.latest?.tag || ''} 记为已读` : '当前没有待确认的新版本';

  // 「⋯」菜单里的导航项 / 重置基线
  const menuLink = el.querySelector('[data-action="release-link"]');
  if (latestUrl) {
    menuLink.href = latestUrl;
    menuLink.hidden = false;
    el.querySelector('[data-field="release-label"]').textContent = r.releaseSource === 'tags' ? '打开 Tag 页面' : '打开最新 Release';
  } else {
    menuLink.hidden = true;
  }
  el.querySelector('[data-action="reset"]').hidden = !r.baseline;

  if (fresh) el.style.animationDelay = `${Math.min(cards.size, 8) * 45}ms`;
}

// ---------------------------------------------------------------- 卡片「更多」菜单
// 单选可用：同时只开一个；Escape 关闭并把焦点还给触发按钮；外部 pointerdown 关闭。
let openMenu = null;

function closeMenu({ restoreFocus = false } = {}) {
  if (!openMenu) return;
  const { menu, trigger } = openMenu;
  menu.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  openMenu = null;
  if (restoreFocus) trigger.focus();
}

function toggleMenu(card) {
  const trigger = card.querySelector('[data-action="menu"]');
  const menu = card.querySelector('[data-field="menu"]');
  if (!trigger || !menu) return;
  if (openMenu?.menu === menu) return closeMenu({ restoreFocus: true });
  closeMenu();
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  openMenu = { menu, trigger };
  menu.querySelector('.menu-item:not([hidden])')?.focus();
}

function menuItems() {
  return openMenu ? [...openMenu.menu.querySelectorAll('.menu-item:not([hidden])')] : [];
}

document.addEventListener('pointerdown', (ev) => {
  if (!openMenu) return;
  if (openMenu.menu.contains(ev.target) || openMenu.trigger.contains(ev.target)) return;
  closeMenu();
});

document.addEventListener('keydown', (ev) => {
  if (!openMenu) return;
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  if (ev.key === 'Escape') { ev.preventDefault(); closeMenu({ restoreFocus: true }); }
  else if (ev.key === 'Tab') { closeMenu(); }
  else if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (ev.key === 'Home') { ev.preventDefault(); items[0]?.focus(); }
  else if (ev.key === 'End') { ev.preventDefault(); items.at(-1)?.focus(); }
});

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
  if (openMenu && !openMenu.menu.isConnected) openMenu = null;

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
  updateFilterThumb();

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

function fmtCountdown(ms) {
  if (ms == null) return '';
  if (ms <= 0) return '可重置';
  var s = Math.ceil(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  if (m > 0) return m + ' 分 ' + sec + ' 秒';
  return sec + ' 秒';
}

/** 用服务端 Date 校准后的“现在”，避免本机时钟偏移把倒计时算飞 */
function quotaNow(rate) {
  var fetched = Date.parse(rate && rate.fetchedAt) || Date.now();
  var base = Date.parse(rate && rate.serverNow) || fetched;
  return base + (Date.now() - fetched);
}

function rateCore() {
  var rate = state.rate;
  if (!rate) return null;
  if (rate.core) return rate.core;
  if (rate.remaining != null || rate.limit != null) return rate;   // 兼容旧后端
  return null;
}

function renderHeader() {
  var badge = $('#rateBadge');
  var core = rateCore();
  if (core) {
    var remaining = core.remaining == null ? '—' : core.remaining;
    var limit = core.limit == null ? '—' : core.limit;
    badge.textContent = 'API ' + remaining + '/' + limit;
    var level = core.remaining === 0 ? 'badge-error' : (core.remaining != null && core.remaining <= 10 ? 'badge-warn' : 'badge-clean');
    badge.className = 'badge badge-mono badge-btn ' + level;
    var left = core.reset ? fmtCountdown(core.reset * 1000 - quotaNow(state.rate)) : '';
    badge.title = 'GitHub API 剩余 ' + remaining + '/' + limit + (left ? ' · ' + left + '后重置' : '') + '（' + (state.hasToken ? 'Token' : '未认证') + '）';
  } else {
    badge.textContent = state.hasToken ? 'API —' : 'API 未认证';
    badge.className = 'badge badge-mono badge-btn badge-clean';
    badge.title = '拿不到 GitHub API 额度（网络问题或 Token 无效）';
  }
}

function renderQuotaRows() {
  var box = $('#quotaRows');
  if (!box) return;
  var rate = state.rate;
  var updated = $('#quotaUpdated');
  var scope = $('#quotaScope');
  if (!rate || !rate.core) {
    box.innerHTML = '<p class="hint is-error">拿不到额度信息：可能是网络问题，或 Token 无效（401）。</p>';
    if (updated) updated.textContent = '—';
    return;
  }
  if (scope) scope.textContent = rate.authenticated ? '按账号共享' : '按 IP 共享';
  var defs = [
    ['core', 'REST core', '项目检查'],
    ['search', 'Search', '每分钟'],
    ['graphql', 'GraphQL', '点数'],
    ['code_search', 'Code search', '每分钟'],
  ];
  var html = '';
  defs.forEach(function (def) {
    var r = rate[def[0]];
    if (!r) return;
    var limit = r.limit == null ? '—' : r.limit;
    var remaining = r.remaining == null ? '—' : r.remaining;
    var used = r.used == null ? '—' : r.used;
    if (r.limit === 0) {
      html += '<div class="api-row" data-resource="' + def[0] + '">';
      html += '<div class="api-row-head"><b>' + def[1] + '</b><span class="mono">未开通</span></div>';
      html += '<div class="api-row-meta"><span>当前 Token / 匿名请求没有这个分桶</span><span>—</span></div>';
      html += '</div>';
      return;
    }
    var pct = (r.limit && r.used != null) ? Math.min(100, Math.round((r.used / r.limit) * 1000) / 10) : 0;
    var level = r.remaining === 0 ? 'danger' : (r.remaining != null && r.limit && r.remaining / r.limit <= 0.1 ? 'warn' : '');
    var resetMs = r.reset ? r.reset * 1000 - quotaNow(rate) : null;
    var resetText = resetMs == null ? '无重置信息' : (resetMs <= 0 ? '已到重置时间' : fmtCountdown(resetMs) + '后重置');
    html += '<div class="api-row" data-resource="' + def[0] + '">';
    html += '<div class="api-row-head"><b>' + def[1] + '</b><span class="mono">剩 ' + remaining + ' / ' + limit + '</span></div>';
    html += '<div class="api-bar" data-level="' + level + '"><span style="width:' + pct + '%"></span></div>';
    html += '<div class="api-row-meta"><span>已用 ' + used + ' · ' + pct + '%</span><span>' + resetText + '</span></div>';
    html += '</div>';
  });
  box.innerHTML = html;
  if (updated) updated.textContent = '更新于 ' + fmtDate(rate.fetchedAt) + (rate.authenticated ? ' · Token' : ' · 未认证');
}

var quotaTimer = null;
async function refreshQuota() {
  try {
    var data = await backend.rate();
    if (data && data.rate) { state.rate = data.rate; renderHeader(); renderQuotaRows(); renderSubs(); }
  } catch { /* 保持旧值，界面会显示上次更新时间 */ }
}

function openQuotaDialog() {
  renderQuotaRows();
  var dialog = $('#quotaDialog');
  if (!dialog.open) dialog.showModal();
  clearInterval(quotaTimer);
  quotaTimer = setInterval(renderQuotaRows, 1000);
  refreshQuota();
}

$('#rateBadge').addEventListener('click', openQuotaDialog);
$('#quotaClose').addEventListener('click', function () { $('#quotaDialog').close(); });
$('#quotaRefresh').addEventListener('click', refreshQuota);
$('#quotaDialog').addEventListener('close', function () { clearInterval(quotaTimer); quotaTimer = null; });

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
    state.subscriptions = data.subscriptions || [];
    state.job = data.job || null;
    state.hasToken = !!data.hasToken;
    state.rate = data.rate || null;
    state.transport = data.transport || null;
    state.lastRunAt = data.lastRunAt || null;
    renderGrid(); renderHeader(); renderJob(); renderSubs();
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
async function runCheckAll({ automatic = false } = {}) {
  if (state.job?.running) return;
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
    if (automatic) toast('启动检查：开始检查 ' + state.repos.length + ' 个项目', 'info');
  } catch (e) {
    if (!automatic) toast(e.message, 'error');
  }
}
$('#checkAllBtn').addEventListener('click', () => runCheckAll());

// ---------------------------------------------------------------- 交互：卡片按钮（事件委托）
grid.addEventListener('click', async (ev) => {
  // 任何真实链接（仓库名 / 版本 tag / 菜单里的导航项）都交给浏览器默认行为。
  // 这里以前没有这道闸：点「Release」会掉进下面的 check/ack 分支，顺手把基线推进了（静默标记已读）。
  if (ev.target.closest('a[href]')) { closeMenu(); return; }
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const card = ev.target.closest('.repo-card');
  const id = card?.dataset.id;
  const repo = state.repos.find((r) => r.id === id);
  if (!repo) return;
  const action = btn.dataset.action;
  const svg = btn.querySelector('svg');

  if (action === 'menu') { toggleMenu(card); return; }
  closeMenu();

  if (action === 'open-repo') { window.open(repo.url, '_blank', 'noopener'); return; }

  if (action === 'delete') {
    const ok = await confirmDialog(`确定要从监测列表里移除 <strong>${esc(repo.owner)}/${esc(repo.repo)}</strong> 吗？`);
    if (!ok) return;
    try {
      await backend.remove(id);
      toast(`已移除 ${repo.owner}/${repo.repo}`, 'success');
      await refresh({ quiet: true });
    } catch (e) { toast(e.message, 'error'); }
    return;
  }

  if (action === 'reset') {
    btn.disabled = true;
    try {
      const res = await backend.reset(id);
      toast(res.note || '基线已清除', 'info');
      await refresh({ quiet: true });
    } catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; }
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
function applyTheme(theme, { animate = false } = {}) {
  const commit = () => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('guw-theme', theme);
    try { window.AndroidTheme && window.AndroidTheme.setTheme(theme); } catch { /* 非安卓环境 */ }
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', theme === 'light' ? '#ffffff' : '#09090b');
    morph($('#themeBtn').querySelector('svg'), theme === 'dark' ? 'moon' : 'sun');
    requestAnimationFrame(updateFilterThumb);
  };
  // View Transitions 的根快照默认是方形；用圆形 clip 从主题按钮扩散。
  // 不支持（旧 WebView）或 prefers-reduced-motion 时直接切，绝不留过渡中途的直角块。
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!animate || reduce || typeof document.startViewTransition !== 'function') { commit(); return; }
  const rect = $('#themeBtn').getBoundingClientRect();
  document.documentElement.style.setProperty('--theme-x', (rect.left + rect.width / 2) + 'px');
  document.documentElement.style.setProperty('--theme-y', (rect.top + rect.height / 2) + 'px');
  try { document.startViewTransition(commit); }
  catch { commit(); }
}
$('#themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', { animate: true });
});

// ---------------------------------------------------------------- 交互：设置对话框
const settingsDialog = $('#settingsDialog');
const confirmEl = $('#confirmDialog');
let confirmResolve = null;

$('#settingsBtn').addEventListener('click', () => {
  $('#tokenInput').value = '';
  var coreQuota = rateCore();
  $('#rateHint').textContent = (coreQuota
    ? `当前 GitHub API 额度：${coreQuota.remaining}/${coreQuota.limit}（${state.hasToken ? '已用 Token' : '未认证，60 次/小时'}）`
    : '拿不到 GitHub API 额度信息，可能是网络问题或 Token 无效。') + ` · 模式：${backend.label}${state.transport ? `（${state.transport}）` : ''}`;
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

// ---------------------------------------------------------------- 节点订阅

function fmtBytes(n) {
  if (n == null) return '—';
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var v = Number(n);
  var i = 0;
  while (v >= 1024 && i < units.length - 1) { v = v / 1024; i++; }
  var text = (i === 0 || v >= 100) ? Math.round(v) : v.toFixed(1);
  return text + ' ' + units[i];
}

function apiRowInfo() {
  var core = rateCore();
  var rate = state.rate;
  if (!core) return { text: '—', pct: null, reset: '', title: '还没有拿到 GitHub API 额度' };
  var limit = core.limit == null ? '—' : core.limit;
  var remaining = core.remaining == null ? '—' : core.remaining;
  var pct = (core.limit && core.used != null) ? Math.min(100, Math.round((core.used / core.limit) * 1000) / 10) : 0;
  var resetMs = core.reset ? core.reset * 1000 - quotaNow(rate) : null;
  var reset = resetMs == null ? '' : (resetMs <= 0 ? '已到重置时间' : fmtCountdown(resetMs) + '后重置');
  return { text: '剩 ' + remaining + ' / ' + limit, pct: pct, reset: reset, title: 'GitHub API 额度按账号/IP 计数，与代理节点无关；所有节点显示同一个值' };
}

function sortSubNodes(sub) {
  var nodes = ((sub.nodes && sub.nodes.nodes) || []).slice();
  nodes.sort(function (a, b) {
    if (state.nodeSort === 'protocol') return String(a.type || '').localeCompare(String(b.type || '')) || a.name.localeCompare(b.name, 'zh');
    return a.name.localeCompare(b.name, 'zh');
  });
  return nodes;
}

function subStatus(sub) {
  if (sub.error) return { cls: 'badge-error', text: '拉取失败', icon: 'circle-alert' };
  if (sub.quota && sub.quota.expired) return { cls: 'badge-warn', text: '已过期', icon: 'clock' };
  if (sub.quota && !sub.quota.unlimited && sub.quota.percent >= 90) return { cls: 'badge-error', text: '流量将尽', icon: 'triangle-alert' };
  if (sub.nodes && sub.nodes.count > 0) return { cls: 'badge-clean', text: '已同步', icon: 'circle-check' };
  return { cls: 'badge-warn', text: '没有节点', icon: 'circle-alert' };
}

function subCardHtml(sub) {
  var q = sub.quota;
  var st = subStatus(sub);
  var pct = (q && !q.unlimited) ? Math.min(100, q.percent) : 0;
  var level = (q && !q.unlimited) ? (q.percent >= 90 ? 'danger' : q.percent >= 70 ? 'warn' : '') : '';
  var usedText = q
    ? (q.unlimited ? '已用 ' + fmtBytes(q.used) : '已用 ' + fmtBytes(q.used) + ' / ' + fmtBytes(q.total))
    : '流量未知';
  var rightText = '';
  if (q) {
    rightText = q.unlimited ? '不限流量' : '剩 ' + fmtBytes(q.remaining);
    if (q.expireAt) rightText += ' · ' + (q.expired ? '已过期' : '到期 ' + q.expireAt.slice(0, 10) + '（' + q.daysLeft + ' 天）');
    else rightText += ' · 长期有效';
  }
  var protos = '';
  var protocols = (sub.nodes && sub.nodes.protocols) || {};
  Object.keys(protocols).slice(0, 6).forEach(function (key) {
    protos += '<span class="proto">' + esc(key) + ' ' + protocols[key] + '</span>';
  });
  var html = '';
  html += '<article class="card sub-card" data-sub-id="' + esc(sub.id) + '">';
  html += '<div class="sub-head"><div class="sub-title">';
  html += '<strong>' + esc(sub.name) + '</strong>';
  html += '<span class="sub-host" title="链接已脱敏">' + esc(sub.maskedUrl) + '</span>';
  html += '</div><span class="badge ' + st.cls + '">' + iconSvg(st.icon, 'icon icon-sm') + '<span>' + st.text + '</span></span></div>';

  if (q) {
    html += '<div class="quota">';
    html += '<div class="quota-row"><span>' + esc(usedText) + '</span><span>' + esc(rightText) + '</span></div>';
    html += '<div class="quota-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="已用流量">';
    html += '<span class="quota-fill" data-level="' + level + '" style="width:' + pct + '%"></span></div>';
    html += '</div>';
  }

  html += '<div class="sub-meta"><span>' + (sub.nodes ? sub.nodes.count : 0) + ' 个节点</span>' + protos;
  html += '<span>更新 ' + fmtDate(sub.lastCheckedAt) + '</span></div>';

  var ranked = sortSubNodes(sub);
  var api = apiRowInfo();
  if (ranked.length) {
    html += '<div class="node-table-wrap"><div class="node-scroll">';
    html += '<table class="node-table"><caption class="sr-only">节点与 GitHub API 额度（只读）</caption>';
    html += '<thead><tr><th scope="col">节点</th><th scope="col">GitHub API</th></tr></thead><tbody>';
    ranked.slice(0, 200).forEach(function (node) {
      var where = node.server ? (node.server + (node.port ? ':' + node.port : '')) : '';
      html += '<tr data-node="' + esc(node.name) + '">';
      html += '<td><div class="node-name"><b>' + esc(node.name) + '</b><span class="node-sub"><span class="proto">' + esc(node.type || '?') + '</span>' + esc(where) + '</span></div></td>';
      html += '<td><div class="node-quota" data-source="api" title="' + esc(api.title) + '">';
      html += '<div class="node-quota-line"><span>' + esc(api.text) + '</span>' + (api.pct == null ? '' : '<span class="src">' + api.pct + '%</span>') + '</div>';
      if (api.pct != null) html += '<div class="node-bar"><span style="width:' + api.pct + '%"></span></div>';
      if (api.reset) html += '<div class="node-reset">' + esc(api.reset) + '</div>';
      html += '</div></td></tr>';
    });
    html += '</tbody></table></div></div>';
    html += '<p class="node-note">这是 <b>GitHub API 请求额度</b>（按账号/IP，所有节点相同），与节点本身无关；订阅流量见卡片顶部。</p>';
  }

  html += '<div class="sub-actions">';
  html += '<button class="btn btn-sm btn-outline" type="button" data-sub-action="refresh">' + iconSvg('refresh-cw', 'icon icon-sm') + '<span>刷新</span></button>';
  html += '<button class="btn btn-sm btn-ghost btn-icon" type="button" data-sub-action="delete" aria-label="删除订阅">' + iconSvg('trash-2', 'icon icon-sm') + '</button>';
  html += '</div>';

  html += '</article>';
  return html;
}

function syncSubControls() {
  var sort = $('#nodeSort');
  if (sort) sort.value = state.nodeSort;
}

function renderSubs() {
  syncSubControls();
  var list = $('#subList');
  if (!list) return;
  var subs = state.subscriptions || [];
  var summary = $('#subSummary');
  if (summary) summary.textContent = subs.length ? (subs.length + ' 个订阅') : '导入机场订阅，查看流量额度与节点';
  if (!subs.length) {
    list.innerHTML = '<p class="sub-empty">还没有订阅。粘贴机场的订阅链接即可读取总流量、到期时间和节点数。</p>';
    return;
  }
  list.innerHTML = subs.map(subCardHtml).join('');
  initAllIcons(list);
}

$('#nodeSort').addEventListener('change', (ev) => {
  state.nodeSort = ev.target.value === 'protocol' ? 'protocol' : 'name';
  try { localStorage.setItem('guw-node-sort', state.nodeSort); } catch { /* 忽略 */ }
  renderSubs();
});

$('#subForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  var input = $('#subInput');
  var nameEl = $('#subName');
  var hint = $('#subHint');
  var btn = $('#subAddBtn');
  var value = input.value.trim();
  if (!value) {
    hint.className = 'hint is-error';
    hint.textContent = '请先填订阅链接。';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  btn.disabled = true;
  try {
    var res = await backend.addSub(value, nameEl.value.trim());
    input.value = '';
    nameEl.value = '';
    input.removeAttribute('aria-invalid');
    hint.className = 'hint';
    hint.textContent = '额度来自订阅响应头 subscription-userinfo；链接只存在本机（服务端加密），界面只显示脱敏形式。';
    toast(res.note || '已导入', res.subscription && res.subscription.error ? 'error' : 'success');
    await refresh({ quiet: true });
  } catch (e) {
    hint.className = 'hint is-error';
    hint.textContent = e.message;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#subList').addEventListener('click', async (ev) => {
  var btn = ev.target.closest('[data-sub-action]');
  if (!btn) return;
  var card = ev.target.closest('.sub-card');
  var id = card ? card.dataset.subId : '';
  var sub = (state.subscriptions || []).find(function (item) { return item.id === id; });
  if (!sub) return;
  var action = btn.dataset.subAction;

  if (action === 'delete') {
    var ok = await confirmDialog('确定要移除订阅 <strong>' + esc(sub.name) + '</strong> 吗？');
    if (!ok) return;
    try {
      await backend.removeSub(id);
      toast('已移除订阅 ' + sub.name, 'success');
      await refresh({ quiet: true });
    } catch (e) { toast(e.message, 'error'); }
    return;
  }

  if (action === 'refresh') {
    btn.disabled = true;
    setBusy(btn.querySelector('svg'), true);
    try {
      var res = await backend.refreshSub(id);
      toast(res.note || '已刷新', res.subscription && res.subscription.error ? 'error' : 'info');
      await refresh({ quiet: true });
    } catch (e) {
      toast(e.message, 'error');
      setBusy(btn.querySelector('svg'), false, 'refresh-cw');
    } finally {
      btn.disabled = false;
    }
  }
});

// ---------------------------------------------------------------- 版本历史（固定 3 行窗口）
// 卡片高度不随交互变化：窗口固定 3 行，多出来的版本在窗口内滚轮/滑动查看。
// 这样"展开历史把邻居卡片撑高"在结构上就不可能再发生（配合 grid align-items:start）。
const releaseCache = new Map();
const releaseLoading = new Set();
const releaseQueue = [];
let releaseWorkers = 0;
const releaseObserver = (typeof IntersectionObserver === 'function')
  ? new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        releaseObserver.unobserve(entry.target);
        queueRelease(entry.target.dataset.id);
      });
    }, { rootMargin: '300px' })
  : null;

function hydrateReleases(el) {
  const box = el.querySelector('[data-field="releases"]');
  if (!box) return;
  const cached = releaseCache.get(el.dataset.id);
  if (cached) { renderReleaseRows(el, cached); return; }
  if (releaseObserver) releaseObserver.observe(el);
  else queueRelease(el.dataset.id);
}

function queueRelease(id) {
  if (!id || releaseCache.has(id) || releaseLoading.has(id) || releaseQueue.indexOf(id) >= 0) return;
  releaseQueue.push(id);
  pumpReleases();
}

function pumpReleases() {
  while (releaseWorkers < 2 && releaseQueue.length) {
    const id = releaseQueue.shift();
    releaseWorkers++;
    loadReleases(id).finally(function () { releaseWorkers--; pumpReleases(); });
  }
}

async function loadReleases(id) {
  releaseLoading.add(id);
  try {
    const data = await backend.releases(id);
    releaseCache.set(id, data.releases || []);
    document.querySelectorAll('.repo-card').forEach(function (el) {
      if (el.dataset.id === id) renderReleaseRows(el, releaseCache.get(id));
    });
  } catch (e) {
    // 版本窗口是附加信息：失败就留空，不动主版本行，也不弹错（主检查会显示错误）
  } finally {
    releaseLoading.delete(id);
  }
}

function renderReleaseRows(el, releases) {
  const box = el.querySelector('[data-field="releases"]');
  if (!box) return;
  if (!releases || !releases.length) { box.hidden = true; return; }
  const repo = state.repos.find(function (r) { return r.id === el.dataset.id; });
  const stripV = function (v) { return String(v || '').replace(/^v/i, '').toLowerCase(); };
  const scroll = el.querySelector('[data-field="releases-scroll"]');
  scroll.innerHTML = releases.map(function (rel) {
    const name = String(rel.name || '').trim();
    const showName = name && stripV(name) !== stripV(rel.tag);
    const latest = repo && repo.latest && rel.tag === repo.latest.tag;
    return '<div class="release-item">'
      + '<span class="tag ' + (latest ? 'tag-new' : '') + '">' + esc(rel.tag) + '</span>'
      + (showName
        ? '<a class="name" href="' + esc(rel.url) + '" target="_blank" rel="noreferrer noopener" title="' + esc(name) + '">' + esc(name.slice(0, 42)) + '</a>'
        : '<span class="name"></span>')
      + '<span class="date">' + fmtDate(rel.publishedAt) + '</span></div>';
  }).join('');
  el.querySelector('[data-field="release-count"]').textContent = '最近 ' + releases.length + ' 个版本';
  box.hidden = false;
}

// ---------------------------------------------------------------- 自更新
const UPDATE_KEY = 'guw-app-update';
const UPDATE_TTL = 6 * 60 * 60 * 1000;

function cmpVersion(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
  const pb = String(b || '0').replace(/^v/i, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function androidUpdateCheck() {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error('检查更新超时')); }, 15000);
    window.__androidUpdate = function (result) { clearTimeout(timer); resolve(result); };
    window.__androidUpdateError = function (message) { clearTimeout(timer); reject(new Error(message)); };
    try { window.AndroidUpdate.check(); } catch (e) { clearTimeout(timer); reject(e); }
  });
}

async function checkAppUpdate(force) {
  const current = window.__GUW_VERSION || '0.0.0';
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(UPDATE_KEY) || 'null'); } catch { /* 忽略 */ }
  if (!force && cached && Date.now() - cached.at < UPDATE_TTL) return cached.data;
  let data;
  if (window.AndroidUpdate) {
    try { data = await androidUpdateCheck(); } catch (e) { return { error: e.message }; }
  } else {
    try {
      const res = await fetch('https://api.github.com/repos/Animal2404/github-update-watch/releases/latest', {
        headers: { accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error('GitHub API HTTP ' + res.status);
      const json = await res.json();
      const assets = json.assets || [];
      const apk = assets.find(function (a) { return /\.apk$/i.test(a.name); });
      const exe = assets.find(function (a) { return /Setup.*\.exe$/i.test(a.name); });
      data = {
        current: current,
        latest: json.tag_name,
        url: json.html_url,
        apk: apk && apk.browser_download_url,
        exe: exe && exe.browser_download_url,
      };
    } catch (e) { return { error: e.message }; }
  }
  if (!data || !data.latest) return { error: '没有解析到版本号' };
  if (!data.current) data.current = current;
  try { localStorage.setItem(UPDATE_KEY, JSON.stringify({ at: Date.now(), data: data })); } catch { /* 忽略 */ }
  return data;
}

async function renderUpdateBadge(force) {
  const btn = $('#updateBtn');
  if (!btn) return;
  const info = await checkAppUpdate(force);
  if (!info || info.error || !info.latest) { btn.hidden = true; return; }
  if (cmpVersion(info.latest, info.current || window.__GUW_VERSION) <= 0) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.innerHTML = iconSvg('package', 'icon icon-sm') + '<span>新版本 ' + esc(info.latest) + '</span>';
  btn.title = '当前 ' + (info.current || window.__GUW_VERSION) + ' → ' + info.latest;
  btn.onclick = function () {
    if (window.AndroidUpdate && info.apk) {
      toast('开始下载 ' + info.latest + '，完成后按系统提示安装', 'info');
      try { window.AndroidUpdate.install(info.apk); } catch (e) { toast(e.message, 'error'); }
      return;
    }
    const target = info.exe || info.url;
    if (target) window.open(target, '_blank', 'noopener');
    toast('已打开 ' + info.latest + ' 的下载', 'info');
  };
}

// ---------------------------------------------------------------- 启动
(async function boot() {
  initAllIcons();
  try { var savedSort = localStorage.getItem('guw-node-sort'); if (savedSort === 'protocol') state.nodeSort = 'protocol'; } catch { /* 忽略 */ }
  applyTheme(localStorage.getItem('guw-theme') || 'dark');
  requestAnimationFrame(updateFilterThumb);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(updateFilterThumb).catch(() => {});
  if (filtersEl && typeof ResizeObserver !== 'undefined') new ResizeObserver(updateFilterThumb).observe(filtersEl);
  window.addEventListener('resize', updateFilterThumb);
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
  // 每次打开软件自动检查所有项目：10 分钟内重复启动不重复刷（额度是共享的 60 次/小时）
  const AUTO_KEY = 'guw-auto-check-at';
  let lastAuto = 0;
  try { lastAuto = Number(localStorage.getItem(AUTO_KEY) || 0); } catch { /* 隐私模式 */ }
  // 自动化验证（navigator.webdriver）不自动发请求：避免测试与真实检查互相干扰
  const automated = navigator.webdriver || /HeadlessChrome/i.test(navigator.userAgent);
  if (!automated && state.repos.length && Date.now() - lastAuto > 10 * 60 * 1000) {
    try { localStorage.setItem(AUTO_KEY, String(Date.now())); } catch { /* 忽略 */ }
    var coreQuota = rateCore();
    if (coreQuota && coreQuota.remaining === 0) {
      toast('GitHub API 额度为 0，已跳过启动检查（重置后自动恢复）', 'info');
    } else {
      runCheckAll({ automatic: true });
    }
  }
  renderUpdateBadge().catch(() => {});

  // 页面重新可见时刷新一次（服务端可能已被别的操作改动）
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.job?.running) refresh({ quiet: true }).catch(() => {}); });
})();

// 供自动化验证脚本读取内部状态的测试钩子（只读，不改变行为）
window.__guw = {
  get state() { return { repos: state.repos, subscriptions: state.subscriptions, rate: state.rate, filter: state.filter, query: state.query, job: state.job, hasToken: state.hasToken, transport: state.transport, theme: document.documentElement.dataset.theme, backend: backend.kind }; },
  icons,
};
