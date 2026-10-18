/**
 * GitHub 更新监测 · 共享核心
 * ---------------------------------------------------------------------------
 * 「有没有新版本」这件事的全部逻辑都在这里，**不碰 DOM、不碰 Node API**：
 *   · semver 比较（含 alpha/rc 预发布排序）
 *   · 链接解析（完整 URL / owner/repo / git@）
 *   · GitHub 取数（releases → tags 降级、限流识别、TTL 缓存）
 *   · 项目列表与基线的状态机（添加/检查/已读/重置）
 *
 * 桌面版（server.mjs，注入 curl 退让链 + 文件存储）、网页版、安卓 APK
 * （注入浏览器 fetch + localStorage）都 import 这一份，
 * 所以「手机和电脑功能一模一样」不是靠人工对齐，而是同一份代码。
 */

/** HTML 转义。任何来自 GitHub 或用户输入的字符串，拼进 innerHTML 之前都必须过这一层。 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

import { fetchSubscription, publicSubscription, subId, normalizeSubUrl, hostOf, maskUrl } from './subs-core.js';

export const CACHE_TTL_MS = 3 * 60 * 1000;
export const TIMEOUT_MS = 25000;
const CONCURRENCY = 3;

// ---------------------------------------------------------------- semver
export function normVersion(input) {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(input ?? ''));
  return m ? m[1] : null;
}
export function parseVer(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(normVersion(v) || '');
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] } : null;
}
function cmpPre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x < +y ? -1 : 1; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
/** a>b 返回 1，a<b 返回 -1，相等 0，无法解析 null（调用方必须按 unknown 处理） */
export function cmpVer(a, b) {
  const A = parseVer(a), B = parseVer(b);
  if (!A || !B) return null;
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1;
  return cmpPre(A.pre, B.pre);
}
export function maxVersion(list) {
  let best = null;
  for (const v of list) {
    if (!parseVer(v)) continue;
    if (best === null || cmpVer(v, best) > 0) best = normVersion(v);
  }
  return best;
}

// ---------------------------------------------------------------- 输入解析
export function parseRepoInput(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  s = s.replace(/\.git$/, '').replace(/\/+$/, '');
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(s);
  if (!m) m = /^git@github\.com:([^/\s]+)\/([^/\s#?]+)/i.exec(s);
  if (!m) m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (!m) return null;
  const owner = m[1], repo = m[2];
  if (!owner || !repo || /^(?:tree|releases|issues|pulls|blob|commits)$/i.test(repo)) return null;
  return { id: `${owner}/${repo}`.toLowerCase(), owner, repo, url: `https://github.com/${owner}/${repo}` };
}

// ---------------------------------------------------------------- 错误
export class AppError extends Error {
  constructor(message, { status, rateLimited } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.rateLimited = !!rateLimited;
  }
}

// ---------------------------------------------------------------- GitHub 取数
/**
 * @param fetchText (url, headers) => Promise<{status, text, body}>
 *        桌面端注入「fetch → curl 直连 → curl 代理」退让链；
 *        浏览器/APK 注入普通 fetch（浏览器自己处理代理与 CORS）。
 */
export function createGithub({ fetchText }) {
  const cache = new Map();

  async function httpGet(url, { headers = {}, fresh = false } = {}) {
    const key = `${url}|${headers.authorization || ''}`;
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await fetchText(url, headers);
    if (value.status >= 200 && value.status < 300) cache.set(key, { at: Date.now(), value });
    return value;
  }

  async function gh(pathname, { token = '', fresh = false, raw = false } = {}) {
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await httpGet(`https://api.github.com${pathname}`, { headers, fresh });
    const body = res.body ?? (() => { try { return JSON.parse(res.text); } catch { return null; } })();
    if (res.status === 403 || res.status === 429) {
      const limited = /rate limit/i.test(body?.message || '') || res.status === 429;
      // 文案必须按「有没有 Token」分支：填了 Token 却被告知"未认证 60 次/小时"会把排查带偏
      const limitedText = token
        ? 'GitHub API 限流已用尽（已用 Token，额度 5000 次/小时）；稍后重试，或在设置里确认 Token 仍然有效'
        : 'GitHub 未认证限流（60 次/小时）已用尽，可在设置里填 Token 提升到 5000 次/小时';
      throw new AppError(limited ? limitedText : (body?.message || `HTTP ${res.status}`), { status: res.status, rateLimited: limited });
    }
    if (res.status === 404) throw new AppError('仓库不存在或不可访问（404）', { status: 404 });
    if (res.status >= 400) throw new AppError(body?.message || `HTTP ${res.status}`, { status: res.status });
    if (raw) return body;
    if (body === null) throw new AppError('返回内容不是合法 JSON');
    return body;
  }

  const PER_PAGE = 30;
  const MAX_PAGES = 3;

  function bestTag(list, tagOf) {
    let best = null;
    for (const item of list) {
      const tag = tagOf(item);
      if (!tag || !parseVer(tag)) continue;
      if (best === null || (cmpVer(tag, best) ?? 0) > 0) best = tag;
    }
    return best;
  }

  /**
   * 按需翻页。默认只取第一页（30 条）；只有同时满足
   *   ① 第一页满载  ② 调用方给了基线  ③ 这一页的最大版本还没超过基线
   * 才继续翻，最多 3 页（90 条）。
   *
   * 为什么需要它：page 1 是按 created_at 排的，不是按版本号。仓库先发 3.0.0、之后又连续
   * 补了 30 个 2.x 热修时，3.0.0 会掉出第一页，旧逻辑就会误判「已是最新」。
   * 首次记录基线（没有 baseline）时只取一页：那时只需要"当前最新"，翻页纯浪费额度。
   */
  async function collectPages(pathname, { token, fresh, baseline, tagOf }) {
    const all = [];
    let pages = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await gh(`${pathname}?per_page=${PER_PAGE}&page=${page}`, { token, fresh });
      pages++;
      if (!Array.isArray(batch) || !batch.length) break;
      all.push(...batch);
      if (batch.length < PER_PAGE) break;                    // 已经是最后一页
      if (!baseline) break;                                  // 首次记录：一页足够
      const best = bestTag(all, tagOf);
      if (best && (cmpVer(best, baseline) ?? 0) > 0) break;   // 已经看到更新，没必要再翻
    }
    return { all, pages };
  }

  /** 最新版本：releases（含预发布，按 semver 取最大）→ 取不到再退到 tags */
  async function fetchLatest(owner, repo, token = '', fresh = false, { baseline = null } = {}) {
    try {
      const { all: releases } = await collectPages(`/repos/${owner}/${repo}/releases`, {
        token, fresh, baseline, tagOf: (r) => r.tag_name,
      });
      const items = (Array.isArray(releases) ? releases : [])
        .filter((r) => !r.draft)
        .map((r) => ({
          tag: r.tag_name, name: r.name || r.tag_name, url: r.html_url,
          publishedAt: r.published_at, prerelease: !!r.prerelease,
        }))
        .filter((r) => r.tag);
      if (items.length) {
        const latest = items.reduce((a, b) => ((cmpVer(b.tag, a.tag) ?? 0) > 0 ? b : a));
        return { latest, source: 'releases', count: items.length };
      }
    } catch (e) {
      if (e instanceof AppError && (e.rateLimited || e.status === 404)) throw e;
      // 其它错误（网络抖动等）继续尝试 tags
    }
    const { all: tags } = await collectPages(`/repos/${owner}/${repo}/tags`, {
      token, fresh, baseline, tagOf: (t) => t.name,
    });
    const list = (Array.isArray(tags) ? tags : []).filter((t) => t.name);
    if (!list.length) throw new AppError('该仓库没有任何 release 或 tag');
    const latest = list.reduce((a, b) => ((cmpVer(b.name, a.name) ?? 0) > 0 ? b : a));
    return {
      latest: {
        tag: latest.name, name: latest.name,
        // tag 兜底时仓库很可能没有 Release 页，/releases/tag/xxx 会 404；/tree/xxx 一定有内容
        url: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(latest.name)}`,
        publishedAt: null, prerelease: false,
      },
      source: 'tags', count: list.length,
    };
  }

  async function rate(token = '') {
    try {
      const r = await gh('/rate_limit', { token });
      return r?.resources?.core || null;
    } catch { return null; }
  }

  return { gh, fetchLatest, rate, clearCache: () => cache.clear(), httpGet };
}

// ---------------------------------------------------------------- 项目记录
export function publicRepo(r) {
  const status = !r.latest ? 'unknown'
    : !r.baseline ? 'no-baseline'
    : (cmpVer(r.latest.tag, r.baseline) ?? 0) > 0 ? 'update' : 'clean';
  return {
    id: r.id, owner: r.owner, repo: r.repo, url: r.url || `https://github.com/${r.id}`,
    canonical: r.canonical || r.id, renamedFrom: r.renamedFrom || null,
    addedAt: r.addedAt, baseline: r.baseline ?? null, baselineAt: r.baselineAt ?? null,
    latest: r.latest || null, releaseSource: r.releaseSource || null,
    description: r.description || '', stars: r.stars ?? null,
    lastCheckedAt: r.lastCheckedAt || null, error: r.error || null, archived: !!r.archived,
    status,
  };
}

/**
 * 项目列表 + 基线状态机。存储与网络都由外部注入，所以桌面/APK 共用同一份行为。
 * @param github  createGithub() 的返回值
 * @param load    () => { repos, settings } | null
 * @param save    (state) => void
 */
export function createStore({ github, load, save, fetchText, subscriptionFetch }) {
  const persisted = load?.() || {};
  const repos = Array.isArray(persisted.repos) ? persisted.repos : [];
  const subscriptions = Array.isArray(persisted.subscriptions) ? persisted.subscriptions : [];
  const settings = { token: '', lastRunAt: null, nodeQuotaMode: 'shared', ...(persisted.settings || {}) };
  let job = null;

  const persist = () => { try { save?.({ repos, settings, subscriptions }); } catch { /* 存储失败不该让功能崩掉 */ } };
  const bySubId = (id) => subscriptions.find((s) => s.id === String(id));

  /** 订阅链接是凭据：错误信息里若带完整 URL，替换成脱敏形式 */
  const safeSubError = (message, url) => {
    const msg = String(message || '订阅拉取失败');
    return url ? msg.split(url).join(maskUrl(url)) : msg;
  };

  async function checkSubscription(rec) {
    if (typeof fetchText !== 'function') {
      rec.error = '当前环境不支持拉取订阅';
      return rec;
    }
    try {
      const result = await fetchSubscription(subscriptionFetch || fetchText, rec.url);
      rec.quota = result.quota;
      rec.format = result.format;
      rec.nodes = { count: result.count, protocols: result.protocols, nodes: result.nodes.slice(0, 200) };
      rec.lastCheckedAt = new Date().toISOString();
      rec.error = null;
    } catch (e) {
      rec.error = safeSubError(e && e.message, rec.url);
      rec.lastCheckedAt = new Date().toISOString();
    }
    return rec;
  }
  const byId = (id) => repos.find((r) => r.id === String(id).toLowerCase());

  async function checkRepo(rec, { setBaseline = false, fresh = false } = {}) {
    const token = settings.token;
    try {
      // 元数据（简介/星标/真名）变化慢，24 小时内复用，避免把未认证额度砍半
      const needMeta = !rec.metaAt || Date.now() - Date.parse(rec.metaAt) > 24 * 3600 * 1000;
      const [meta, latestInfo] = await Promise.all([
        needMeta ? github.gh(`/repos/${rec.owner}/${rec.repo}`, { token, fresh }).catch(() => null) : Promise.resolve(null),
        github.fetchLatest(rec.owner, rec.repo, token, fresh, { baseline: rec.baseline || null }),
      ]);
      if (meta) {
        rec.metaAt = new Date().toISOString();
        rec.description = meta.description || '';
        rec.stars = meta.stargazers_count ?? null;
        rec.archived = !!meta.archived;
        // 仓库改名/迁移时 GitHub 会 301 到新名字，照实记下当前真名
        const canonical = meta.full_name || rec.id;
        rec.canonical = canonical;
        rec.renamedFrom = canonical.toLowerCase() === rec.id ? null : rec.id;
        rec.url = meta.html_url || `https://github.com/${canonical}`;
      }
      rec.latest = latestInfo.latest;
      rec.releaseSource = latestInfo.source;
      rec.lastCheckedAt = new Date().toISOString();
      rec.error = null;
      if (!rec.baseline || setBaseline) { rec.baseline = latestInfo.latest.tag; rec.baselineAt = rec.lastCheckedAt; }
    } catch (e) {
      rec.error = e instanceof AppError ? e.message : `网络错误：${e.message}`;
      rec.lastCheckedAt = new Date().toISOString();
    }
    return rec;
  }

  function note(rec, prefix) {
    if (rec.error) return `${prefix}失败：${rec.error}`;
    const c = rec.latest && rec.baseline ? cmpVer(rec.latest.tag, rec.baseline) : 0;
    return c > 0 ? `${prefix}发现新版本 ${rec.latest.tag}` : `${prefix}已是最新`;
  }

  return {
    get repos() { return repos; },
    get subscriptions() { return subscriptions; },
    get settings() { return settings; },
    get job() { return job; },

    getState: (extra = {}) => ({
      repos: repos.map(publicRepo),
      subscriptions: subscriptions.map(publicSubscription),
      job,
      hasToken: !!settings.token,
      tokenHint: settings.token ? `${settings.token.slice(0, 4)}••••${settings.token.slice(-4)}` : '',
      lastRunAt: settings.lastRunAt,
      nodeQuotaMode: settings.nodeQuotaMode === 'estimate' ? 'estimate' : 'shared',
      ...extra,
    }),

    async add(input) {
      const parsed = parseRepoInput(input);
      if (!parsed) throw new AppError('识别不出仓库，请填 owner/repo 或完整 GitHub 链接');
      if (byId(parsed.id)) throw new AppError('这个项目已经在列表里了');
      const rec = { ...parsed, addedAt: new Date().toISOString(), baseline: null, latest: null, error: null };
      await checkRepo(rec, { setBaseline: true, fresh: true });
      repos.unshift(rec);
      persist();
      return { repo: publicRepo(rec), note: rec.error ? `已添加，但首次检查失败：${rec.error}` : `已添加，基线 ${rec.baseline}` };
    },

    // ---------------------------------------------------------------- 节点订阅
    async addSubscription(input, name) {
      let url;
      try { url = normalizeSubUrl(input); }
      catch (e) { throw new AppError(e.message); }   // 交给服务端映射成 400，而不是 500
      const id = subId(url);
      if (bySubId(id) || subscriptions.some((s) => s.url === url)) throw new AppError('这个订阅已经在列表里了');
      const rec = {
        id,
        url,
        name: String(name || '').trim() || hostOf(url),
        addedAt: new Date().toISOString(),
        lastCheckedAt: null,
        error: null,
        format: null,
        quota: null,
        nodes: { count: 0, protocols: {}, nodes: [] },
      };
      await checkSubscription(rec);
      subscriptions.unshift(rec);
      persist();
      const pub = publicSubscription(rec);
      return {
        subscription: pub,
        note: rec.error
          ? `已添加，但订阅拉取失败：${rec.error}`
          : `已导入：${pub.nodes.count} 个节点${pub.quota && !pub.quota.unlimited ? `，已用 ${pub.quota.percent}%` : ''}`,
      };
    },

    async refreshSubscription(id) {
      const rec = bySubId(id);
      if (!rec) throw new AppError('没有这个订阅');
      await checkSubscription(rec);
      persist();
      return {
        subscription: publicSubscription(rec),
        note: rec.error ? `刷新失败：${rec.error}` : `已刷新：${rec.nodes.count} 个节点`,
      };
    },

    removeSubscription(id) {
      const i = subscriptions.findIndex((s) => s.id === String(id));
      if (i < 0) throw new AppError('没有这个订阅');
      subscriptions.splice(i, 1);
      persist();
      return { ok: true };
    },

    remove(id) {
      const i = repos.findIndex((r) => r.id === String(id).toLowerCase());
      if (i < 0) throw new AppError('没有这个项目');
      repos.splice(i, 1);
      persist();
      return { ok: true };
    },

    async check(id) {
      const rec = byId(id);
      if (!rec) throw new AppError('没有这个项目');
      await checkRepo(rec, { fresh: true });
      persist();
      return { repo: publicRepo(rec), note: note(rec, '检查完成：') };
    },

    ack(id) {
      const rec = byId(id);
      if (!rec) throw new AppError('没有这个项目');
      if (!rec.latest) throw new AppError('还没有检查结果，先检查一次');
      rec.baseline = rec.latest.tag;
      rec.baselineAt = new Date().toISOString();
      persist();
      return { repo: publicRepo(rec), note: `已把 ${rec.baseline} 记为已读基线` };
    },

    reset(id) {
      const rec = byId(id);
      if (!rec) throw new AppError('没有这个项目');
      rec.baseline = null; rec.baselineAt = null;
      persist();
      return { repo: publicRepo(rec), note: '基线已清除，下次检查重新记录' };
    },

    async releases(id) {
      const rec = byId(id);
      if (!rec) throw new AppError('没有这个项目');
      const list = await github.gh(`/repos/${rec.owner}/${rec.repo}/releases?per_page=10`, { token: settings.token });
      return {
        releases: (Array.isArray(list) ? list : []).filter((r) => !r.draft).map((r) => ({
          tag: r.tag_name, name: r.name || r.tag_name, url: r.html_url,
          publishedAt: r.published_at, prerelease: !!r.prerelease,
        })),
      };
    },

    /** 全部检查：并发 3，逐个更新 job 进度，供界面轮询 */
    async checkAll({ onTick } = {}) {
      if (job?.running) throw new AppError('已经在检查中了');
      if (!repos.length) throw new AppError('列表是空的，先添加项目');
      const queue = [...repos];
      job = { running: true, total: queue.length, done: 0, current: null, failed: 0, startedAt: new Date().toISOString(), finishedAt: null };
      onTick?.(job);
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
          const rec = queue.shift();
          job.current = rec.id;
          await checkRepo(rec, { fresh: true });
          if (rec.error) job.failed++;
          job.done++;
          onTick?.(job);
        }
      });
      await Promise.all(workers);
      job.running = false;
      job.current = null;
      job.finishedAt = new Date().toISOString();
      settings.lastRunAt = job.finishedAt;
      persist();
      return job;
    },

    setToken(token) {
      settings.token = String(token || '').trim();
      github.clearCache();
      persist();
      return { hasToken: !!settings.token, note: settings.token ? 'Token 已保存（可提升到 5000 次/小时）' : 'Token 已清除' };
    },

    /** 节点额度口径：shared=整条订阅共用（真实）；estimate=剩余额度÷节点数（标注为估算） */
    setNodeQuotaMode(mode) {
      settings.nodeQuotaMode = mode === 'estimate' ? 'estimate' : 'shared';
      persist();
      return { nodeQuotaMode: settings.nodeQuotaMode };
    },

    /** 首次使用的示例项目（只在没有数据文件时用） */
    async seed(ids) {
      for (const id of ids) {
        const parsed = parseRepoInput(id);
        if (!parsed || byId(parsed.id)) continue;
        const rec = { ...parsed, addedAt: new Date().toISOString(), baseline: null, latest: null, error: null };
        await checkRepo(rec, { setBaseline: true, fresh: true });
        repos.push(rec);
      }
      settings.lastRunAt = new Date().toISOString();
      persist();
    },
  };
}
