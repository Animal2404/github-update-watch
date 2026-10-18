/**
 * 纯逻辑单元测试（node:test，零依赖）
 *   node --test test/
 *
 * 这些函数是「有没有新版本」的全部判断依据，而且不需要浏览器/网络：
 * semver 排序、链接解析、HTML 转义、releases→tags 降级、基线状态机。
 * 以前只有 E2E 按钮测试，这几处回归一次就得靠人肉发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cmpVer, maxVersion, parseRepoInput, esc, createGithub, createStore, AppError,
} from '../public/github-core.js';

test('semver：正式版高于预发布，预发布按数字/字典序逐段比较', () => {
  assert.equal(cmpVer('0.2.0', '0.2.0-rc.2'), 1);
  assert.equal(cmpVer('0.2.0-rc.2', '0.2.0'), -1);
  assert.equal(cmpVer('0.2.0-rc.10', '0.2.0-rc.2'), 1);
  assert.equal(cmpVer('0.2.0-rc.2', '0.1.6'), 1);
  assert.equal(cmpVer('v1.2.3', '1.2.3'), 0);
  assert.equal(cmpVer('1.2.3+build.5', '1.2.3'), 0);
  assert.equal(cmpVer('dsh-v0.2.1-alpha.1', '0.2.1-alpha.1'), 0);
  assert.equal(cmpVer('1.2', '1.2.0'), null, '两段式版本必须判为无法比较，不能静默当相等');
  assert.equal(cmpVer('nightly', '1.0.0'), null);
});

test('maxVersion：忽略无法解析的 tag，取 semver 最大值（含预发布）', () => {
  assert.equal(maxVersion(['nightly', 'v1.9.0', 'v1.10.0', 'v2.0.0-rc.1']), '2.0.0-rc.1');
  assert.equal(maxVersion(['nightly', 'latest']), null);
});

test('parseRepoInput：链接 / 短名 / ssh / 子路径都能解析成同一个 id', () => {
  const cases = [
    'https://github.com/facebook/react',
    'https://github.com/facebook/react/',
    'http://www.github.com/facebook/react/tree/main',
    'facebook/react',
    'git@github.com:facebook/react.git',
    'https://github.com/facebook/react.git',
  ];
  for (const input of cases) {
    const p = parseRepoInput(input);
    assert.ok(p, '应该能解析：' + input);
    assert.equal(p.id, 'facebook/react', input);
    assert.equal(p.url, 'https://github.com/facebook/react');
  }
  assert.equal(parseRepoInput(''), null);
  assert.equal(parseRepoInput('not a repo'), null);
  assert.equal(parseRepoInput('https://gitlab.com/a/b'), null);
});

test('esc：把网络字符串拼进 innerHTML 前必须转义掉标签与引号', () => {
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(esc('a"b\'c'), 'a&quot;b&#39;c');
  assert.equal(esc('v1.0.0 & more'), 'v1.0.0 &amp; more');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(2026), '2026');
});

// ---------------------------------------------------------------- 网络层：releases → tags 降级
function githubStub(routes) {
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const value = key ? routes[key] : { status: 404, text: '{"message":"Not Found"}' };
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return { status: key ? 200 : 404, text, body: JSON.parse(text) };
  };
  return { gh: createGithub({ fetchText }), calls, fetchText };
}

test('fetchLatest：多个 release 取 semver 最大，draft 不参与', async () => {
  const { gh } = githubStub({
    '/releases': [
      { tag_name: 'v2.0.0', name: 'v2.0.0', html_url: 'u2', published_at: null, prerelease: false, draft: false },
      { tag_name: 'v1.9.0', name: 'v1.9.0', html_url: 'u1', published_at: null, prerelease: false, draft: false },
      { tag_name: 'v9.9.9', name: 'draft', html_url: 'u9', published_at: null, prerelease: false, draft: true },
    ],
  });
  const info = await gh.fetchLatest('o', 'r');
  assert.equal(info.source, 'releases');
  assert.equal(info.latest.tag, 'v2.0.0');
  assert.equal(info.latest.body, undefined, 'release 正文不该再被取回并落盘');
});

test('fetchLatest：没有 release 时退到 tags，链接指向 /tree/（tag 不一定有 Release 页）', async () => {
  const { gh } = githubStub({
    '/releases': [],
    '/tags': [{ name: 'v1.0.0' }, { name: 'v1.2.0' }],
  });
  const info = await gh.fetchLatest('o', 'r');
  assert.equal(info.source, 'tags');
  assert.equal(info.latest.tag, 'v1.2.0');
  assert.match(info.latest.url, /\/tree\/v1\.2\.0$/);
});

test('限流文案按是否有 Token 分支（带 Token 时不能说"未认证 60 次/小时"）', async () => {
  const limited = { status: 403, text: '{"message":"API rate limit exceeded"}' };
  const anon = createGithub({ fetchText: async () => ({ ...limited, body: JSON.parse(limited.text) }) });
  await assert.rejects(() => anon.gh('/user'), (e) => {
    assert.ok(e instanceof AppError && e.rateLimited);
    assert.match(e.message, /未认证/);
    return true;
  });
  const authed = createGithub({ fetchText: async () => ({ ...limited, body: JSON.parse(limited.text) }) });
  await assert.rejects(() => authed.gh('/user', { token: 'ghp_x' }), (e) => {
    assert.ok(e.rateLimited);
    assert.match(e.message, /已用 Token/);
    assert.doesNotMatch(e.message, /未认证/);
    return true;
  });
});

// ---------------------------------------------------------------- 基线状态机
test('基线状态机：添加记基线 → 有新版本 → 标记已读推进 → 重置基线', async () => {
  let latestTag = '1.0.0';
  const github = {
    gh: async () => ({ full_name: 'o/r', html_url: 'https://github.com/o/r', description: 'd', stargazers_count: 1, archived: false }),
    fetchLatest: async () => ({ latest: { tag: latestTag, name: latestTag, url: '', publishedAt: null, prerelease: false }, source: 'releases', count: 1 }),
    rate: async () => null,
    clearCache() {},
  };
  let persisted = null;
  const store = createStore({ github, load: () => persisted, save: (s) => { persisted = s; } });

  const added = await store.add('https://github.com/o/r');
  assert.equal(added.repo.status, 'clean');
  assert.equal(added.repo.baseline, '1.0.0');

  latestTag = '1.1.0';
  await store.check('o/r');
  assert.equal(store.getState().repos[0].status, 'update');

  store.ack('o/r');
  assert.equal(store.getState().repos[0].status, 'clean');
  assert.equal(store.getState().repos[0].baseline, '1.1.0');

  store.reset('o/r');
  assert.equal(store.getState().repos[0].status, 'no-baseline');
  assert.equal(store.getState().repos[0].baseline, null);
  assert.ok(persisted, '状态变化必须落盘');
});


// ---------------------------------------------------------------- 翻页兜底
function pageStub(pagesByPage, { tags = false, releasePages = null } = {}) {
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] || '1');
    const map = releasePages && url.includes('/releases') ? releasePages : pagesByPage;
    const list = map[page] || [];
    const body = list.map((tag) => tags
      ? { name: tag }
      : { tag_name: tag, name: tag, html_url: 'u', published_at: null, prerelease: false, draft: false });
    return { status: 200, text: JSON.stringify(body), body };
  };
  return { github: createGithub({ fetchText }), calls };
}
const fullPage = (prefix) => Array.from({ length: 30 }, (_, i) => `${prefix}.${i}`);

test('翻页：第一页满载且没超过基线时继续翻（更旧的发布里可能藏着更高版本）', async () => {
  const { github, calls } = pageStub({ 1: fullPage('v2.0'), 2: ['v3.0.0'] });
  const info = await github.fetchLatest('o', 'r', '', true, { baseline: 'v2.5.0' });
  assert.equal(info.latest.tag, 'v3.0.0');
  assert.equal(calls.length, 2, '应恰好翻到第 2 页');
  assert.match(calls[0], /page=1/);
  assert.match(calls[1], /page=2/);
});

test('翻页：没有基线（首次记录）不翻页，省额度', async () => {
  const { github, calls } = pageStub({ 1: fullPage('v2.0'), 2: ['v9.9.9'] });
  const info = await github.fetchLatest('o', 'r');
  assert.equal(info.latest.tag, 'v2.0.29');
  assert.equal(calls.length, 1);
});

test('翻页：第一页已经超过基线就停（有更新时不多花请求）', async () => {
  const { github, calls } = pageStub({ 1: fullPage('v2.0'), 2: ['v9.9.9'] });
  const info = await github.fetchLatest('o', 'r', '', true, { baseline: 'v1.0.0' });
  assert.equal(info.latest.tag, 'v2.0.29');
  assert.equal(calls.length, 1);
});

test('翻页：有上界（最多 3 页），不会无休止翻下去', async () => {
  const { github, calls } = pageStub({
    1: fullPage('v2.0'), 2: fullPage('v2.1'), 3: fullPage('v2.2'), 4: ['v9.9.9'],
  });
  const info = await github.fetchLatest('o', 'r', '', true, { baseline: 'v3.0.0' });
  assert.equal(info.latest.tag, 'v2.2.29');
  assert.equal(calls.length, 3, '上界应为 3 页');
});

test('翻页：tags 兜底同样受上界约束', async () => {
  const { github, calls } = pageStub(
    { 1: fullPage('v1.0'), 2: fullPage('v1.1'), 3: fullPage('v1.2'), 4: fullPage('v1.3') },
    { tags: true, releasePages: { 1: [] } },
  );
  const info = await github.fetchLatest('o', 'r', '', true, { baseline: 'v2.0.0' });
  assert.equal(info.source, 'tags');
  assert.equal(info.latest.tag, 'v1.2.29');
  assert.equal(calls.length, 4, 'releases 1 次 + tags 最多 3 页');
});
