import test from 'node:test';
import assert from 'node:assert/strict';
import {
  subId, normalizeSubUrl, maskUrl, hostOf, headerValue,
  parseUserInfo, quotaView, parseSubscriptionBody, publicSubscription, nodeQuotaView,
} from '../public/subs-core.js';
import { createStore, createGithub } from '../public/github-core.js';

const URI_LIST = [
  'ss://YWVzLTI1Ni1nY206cGFzcw@1.1.1.1:443#%E9%A6%99%E6%B8%AF%2001',
  'vmess://eyJ2IjoiMiIsInBzIjoi5pel5pysIDAyIn0=',
  'trojan://pass@example.com:443#SG%2003',
  'vless://uuid@example.com:443?type=ws#US%2004',
].join('\n');

const CLASH_YAML = [
  'proxies:',
  '  - {name: "HK 01", type: ss, server: 1.1.1.1, port: 443}',
  '  - name: JP 02',
  '    type: vmess',
  '    server: 2.2.2.2',
  '  - name: DIRECT',
  '    type: direct',
  'proxy-groups:',
  '  - name: auto',
  '    type: url-test',
].join('\n');

test('订阅链接：只接受 http(s)，id 稳定，展示脱敏且不泄露路径 token', () => {
  assert.equal(normalizeSubUrl('https://a.example/sub?token=SECRET'), 'https://a.example/sub?token=SECRET');
  assert.throws(() => normalizeSubUrl('ftp://x'), /http/);
  assert.throws(() => normalizeSubUrl(''), /请先填/);
  assert.equal(subId('https://a.example/sub'), subId('https://a.example/sub'));
  assert.notEqual(subId('https://a.example/sub'), subId('https://b.example/sub'));
  const masked = maskUrl('https://a.example/sub?token=SECRET');
  assert.equal(masked, 'https://a.example/••••' + subId('https://a.example/sub?token=SECRET').slice(-4));
  assert.ok(!masked.includes('SECRET'));
  assert.equal(hostOf('https://a.example/sub'), 'a.example');
});

test('subscription-userinfo：解析额度与到期；没有 total 就返回 null（不臆造）', () => {
  assert.deepEqual(parseUserInfo('upload=1; download=2; total=100; expire=1700000000'), {
    upload: 1, download: 2, total: 100, expire: 1700000000,
  });
  assert.equal(parseUserInfo('upload=1; download=2'), null);
  assert.equal(parseUserInfo(''), null);
  assert.equal(parseUserInfo('total=abc'), null);
  assert.equal(headerValue({ 'Subscription-Userinfo': 'x' }, 'subscription-userinfo'), 'x');
  assert.equal(headerValue({ 'subscription-userinfo': 'y' }, 'Subscription-Userinfo'), 'y');
});

test('quotaView：百分比 / 剩余 / 到期天数 / 过期 / 不限量', () => {
  const now = 1_700_000_000_000;
  const v = quotaView({ upload: 10, download: 30, total: 100, expire: 1_700_086_400 }, now);
  assert.equal(v.used, 40);
  assert.equal(v.percent, 40);
  assert.equal(v.remaining, 60);
  assert.equal(v.daysLeft, 1);
  assert.equal(v.expired, false);
  assert.equal(v.unlimited, false);
  assert.equal(quotaView({ upload: 1, download: 1, total: 0, expire: 0 }, now).unlimited, true);
  assert.equal(quotaView({ upload: 1, download: 1, total: 2, expire: 1 }, now).expired, true);
  assert.equal(quotaView(null), null);
});

test('正文解析：明文 URI / base64 / Clash YAML 都能给出节点与协议分布', () => {
  const plain = parseSubscriptionBody(URI_LIST);
  assert.equal(plain.format, 'uri');
  assert.equal(plain.count, 4);
  assert.deepEqual(plain.protocols, { ss: 1, vmess: 1, trojan: 1, vless: 1 });
  assert.equal(plain.nodes[0].name, '香港 01');

  const encoded = parseSubscriptionBody(Buffer.from(URI_LIST, 'utf8').toString('base64'));
  assert.equal(encoded.format, 'uri');
  assert.equal(encoded.count, 4);

  const clash = parseSubscriptionBody(CLASH_YAML);
  assert.equal(clash.format, 'clash');
  assert.equal(clash.count, 2, 'DIRECT 不属于节点');
  assert.deepEqual(clash.protocols, { ss: 1, vmess: 1 });
  assert.equal(clash.nodes[0].name, 'HK 01');

  const unknown = parseSubscriptionBody('hello world');
  assert.equal(unknown.count, 0);
  assert.equal(unknown.format, 'unknown');
});

test('publicSubscription：只暴露脱敏信息，额度换算成视图', () => {
  const pub = publicSubscription({
    id: 'sub-1', url: 'https://a.example/sub?token=SECRET', name: '测试',
    quota: { upload: 0, download: 50, total: 100, expire: 0 },
    nodes: { count: 2, protocols: { ss: 2 }, nodes: [{ name: 'n1', type: 'ss' }] },
  });
  assert.ok(!JSON.stringify(pub).includes('SECRET'), '公开视图不能包含完整 URL');
  assert.equal(pub.quota.percent, 50);
  assert.equal(pub.nodes.count, 2);
});

test('store：导入 / 重复 / 刷新失败脱敏 / 删除 / 持久化', async () => {
  const b64 = Buffer.from(URI_LIST, 'utf8').toString('base64');
  let failNext = false;
  const fetchText = async () => {
    if (failNext) throw new Error('connect failed for https://a.example/sub?token=SECRET');
    return { status: 200, text: b64, headers: { 'subscription-userinfo': 'upload=1; download=1; total=100; expire=1795000000' } };
  };
  const github = { gh: async () => null, fetchLatest: async () => null, rate: async () => null, clearCache() {} };
  let persisted = null;
  const store = createStore({ github, fetchText, load: () => persisted, save: (s) => { persisted = s; } });

  const added = await store.addSubscription('https://a.example/sub?token=SECRET', '我的机场');
  assert.equal(added.subscription.nodes.count, 4);
  assert.equal(added.subscription.quota.percent, 2);
  assert.equal(persisted.subscriptions.length, 1);
  assert.ok(!JSON.stringify(store.getState().subscriptions).includes('SECRET'));

  await assert.rejects(() => store.addSubscription('https://a.example/sub?token=SECRET'), /已经在列表/);

  failNext = true;
  await store.refreshSubscription(added.subscription.id);
  const after = store.getState().subscriptions[0];
  assert.match(after.error, /connect failed/);
  assert.ok(!after.error.includes('SECRET'), '错误信息里不能带完整订阅链接');

  store.removeSubscription(added.subscription.id);
  assert.equal(store.getState().subscriptions.length, 0);
});


test('节点解析：server/port 与机场自带的节点额度元数据', () => {
  const uri = 'ss://YWVzLTI1Ni1nY206cGFzcw@1.2.3.4:8443#HK%2001?total=1073741824&used=268435456&expire=1795000000';
  const parsed = parseSubscriptionBody(uri);
  assert.equal(parsed.count, 1);
  const node = parsed.nodes[0];
  assert.equal(node.name, 'HK 01');
  assert.equal(node.server, '1.2.3.4');
  assert.equal(node.port, 8443);
  assert.equal(node.quota.total, 1073741824);
  assert.equal(node.quota.download, 268435456);
  assert.equal(node.quota.expire, 1795000000);

  const clash = parseSubscriptionBody('proxies:\n  - {name: "JP", type: trojan, server: jp.example.com, port: 443}');
  assert.equal(clash.nodes[0].server, 'jp.example.com');
  assert.equal(clash.nodes[0].port, 443);
});

test('节点额度视图：共用 / 均分估算 / 机场节点额度 / 未知，来源必须区分', () => {
  const now = 1_700_000_000_000;
  const sub = { upload: 10, download: 30, total: 100, expire: 1_700_086_400 };
  const shared = nodeQuotaView({ name: 'a', type: 'ss' }, sub, 4, 'shared', now);
  assert.equal(shared.source, 'shared');
  assert.equal(shared.percent, 40);
  assert.equal(shared.remaining, 60);

  const estimate = nodeQuotaView({ name: 'a', type: 'ss' }, sub, 4, 'estimate', now);
  assert.equal(estimate.source, 'estimate');
  assert.equal(estimate.remaining, 15);
  assert.equal(estimate.percent, 40);

  const own = nodeQuotaView({ name: 'b', type: 'ss', quota: { upload: 0, download: 50, total: 100, expire: 0 } }, sub, 4, 'shared', now);
  assert.equal(own.source, 'node');
  assert.equal(own.percent, 50);

  assert.equal(nodeQuotaView({ name: 'c', type: 'ss' }, null, 4, 'shared', now).source, 'unknown');
});


test('nodes quota mode：默认 shared，estimate 可持久化，非法值回落', () => {
  const github = { gh: async () => null, fetchLatest: async () => null, rate: async () => null, clearCache() {} };
  let persisted = null;
  const store = createStore({ github, load: () => persisted, save: (s) => { persisted = s; } });
  assert.equal(store.getState().nodeQuotaMode, 'shared');
  store.setNodeQuotaMode('estimate');
  assert.equal(store.getState().nodeQuotaMode, 'estimate');
  assert.equal(persisted.settings.nodeQuotaMode, 'estimate');
  store.setNodeQuotaMode('bogus');
  assert.equal(store.getState().nodeQuotaMode, 'shared');
});


test('GitHub API 额度：core/search/graphql 分桶 + 服务端 Date 校准', async () => {
  const body = { resources: {
    core: { limit: 60, remaining: 0, used: 60, reset: 1793000000 },
    search: { limit: 10, remaining: 9, used: 1, reset: 1793000060 },
    graphql: { limit: 0, remaining: 0, used: 0, reset: 0 },
  } };
  const date = 'Mon, 19 Oct 2026 17:00:00 GMT';
  const gh = createGithub({ fetchText: async () => ({ status: 200, text: JSON.stringify(body), headers: { date } }) });
  const rate = await gh.rate('');
  assert.equal(rate.core.limit, 60);
  assert.equal(rate.core.remaining, 0);
  assert.equal(rate.core.used, 60);
  assert.equal(rate.search.limit, 10);
  assert.equal(rate.graphql.limit, 0);
  assert.equal(rate.authenticated, false);
  assert.equal(rate.serverNow, new Date(date).toISOString());

  const noDate = createGithub({ fetchText: async () => ({ status: 200, text: JSON.stringify(body), headers: {} }) });
  const r2 = await noDate.rate('t');
  assert.equal(r2.authenticated, true);
  assert.ok(r2.serverNow, '没有 Date 头时也必须给出 serverNow 兜底');
});

test('GitHub API 额度：没有 core 或请求失败时返回 null（不伪造 0）', async () => {
  const gh = createGithub({ fetchText: async () => ({ status: 200, text: JSON.stringify({ resources: { search: { limit: 10, remaining: 1, used: 9, reset: 1 } } }), headers: {} }) });
  assert.equal(await gh.rate(''), null);
  const down = createGithub({ fetchText: async () => { throw new Error('network'); } });
  assert.equal(await down.rate(''), null);
});
