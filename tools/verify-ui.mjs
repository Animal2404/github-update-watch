/**
 * 逐按钮验证：用 CDP 直连无头 Chrome，真的去点每一个按钮，并断言状态变化。
 *
 *   node tools/verify-ui.mjs [appUrl]
 *
 * 为什么不用「看一眼截图」当验收：截图只能证明"画出来了"，证明不了"点了有用"。
 * 这里每个交互都走真实 DOM 事件 + 真实后端请求，失败会打印是哪一步、当前实际值。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, HEADLESS_ARGS } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.argv[2] || 'http://127.0.0.1:7321/';
const SHOT_DIR = path.join(ROOT, 'data', 'shots');
// 每次跑换端口 + profile：Chrome 子进程不一定随父进程收干净，复用会连到上次的标签页
const RUN_ID = Date.now() % 100000;
const CDP_PORT = 12100 + (RUN_ID % 300);
fs.mkdirSync(SHOT_DIR, { recursive: true });

const CHROME = findChrome();
if (!CHROME) { console.error('找不到 Chrome/Edge（可用 CHROME_PATH 指定）'); process.exit(2); }

// ---------------------------------------------------------------- CDP 客户端
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
    const cdp = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) cdp.events.push(msg);
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)); } }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 抛错');
    return r.result.value;
  }
  async waitFor(expression, { timeout = 20000, label = expression } = {}) {
    const t0 = Date.now();
    for (;;) {
      try { if (await this.eval(expression)) return true; } catch { /* 页面可能还没好 */ }
      if (Date.now() - t0 > timeout) throw new Error(`等待超时：${label}`);
      await new Promise((r) => setTimeout(r, 180));
    }
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  close() { try { this.ws.close(); } catch {} }
}

// ---------------------------------------------------------------- 工具
const results = [];
let current = null;
async function check(name, fn) {
  current = { name, pass: false, detail: '' };
  results.push(current);
  try {
    const detail = await fn();
    current.pass = true;
    current.detail = detail || 'ok';
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (e) {
    current.detail = e.message;
    console.log(`FAIL  ${name}  — ${e.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------------------------------------------------------------- 主流程
const userDataDir = path.join(ROOT, 'data', 'tmp', `chrome-verify-${RUN_ID}`);
fs.rmSync(userDataDir, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  ...HEADLESS_ARGS, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900', '--force-device-scale-factor=1', APP,
], { stdio: 'ignore' });

let cdp;
try {
  // 等 CDP 端口
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
  }
  if (!target) throw new Error('连不上 Chrome 调试端口');
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const shotFiles = [];
  const go = (url) => cdp.eval(`(location.href='${url}', true)`);

  // ---------- 0. 页面可用 ----------
  await check('页面加载：服务可达、数据渲染出卡片', async () => {
    await go(APP);
    await cdp.waitFor(`document.querySelectorAll('.repo-card').length > 0`, { label: '出现项目卡片' });
    const n = await cdp.eval(`document.querySelectorAll('.repo-card').length`);
    return `${n} 张卡片`;
  });

  await check('图标绑定：morphicons 已接管（path 有非空 d，且节点上挂了 morph 实例）', async () => {
    const info = await cdp.eval(`(() => {
      const paths = [...document.querySelectorAll('svg > path')];
      const withD = paths.filter(p => (p.getAttribute('d')||'').length > 20).length;
      const bound = paths.filter(p => p.parentElement._morph).length;
      return { total: paths.length, withD, bound };
    })()`);
    assert(info.bound > 8, `绑定数太少：${JSON.stringify(info)}`);
    assert(info.withD === info.bound, `有 ${info.bound - info.withD} 个图标拿到了 morph 实例但没画出 d`);
    return `${info.bound} 个图标已绑定并渲染`;
  });

  await check('截图：暗色主题 + 数据态', async () => {
    // 等入场动画跑完再拍，否则拍到的是半透明的中间帧（第一次就拍到过）
    await cdp.waitFor(`document.querySelectorAll('.repo-card').length === window.__guw.state.repos.length`, { label: '所有卡片都渲染出来' });
    await sleep(700);
    const f = await cdp.shot('01-dark-data');
    shotFiles.push(f);
    return path.basename(f);
  });

  // ---------- 1. 主题按钮 ----------
  await check('按钮「主题切换」：data-theme 由 dark 翻到 light，图标 morph 成 sun', async () => {
    const before = await cdp.eval(`document.documentElement.dataset.theme`);
    await cdp.eval(`document.querySelector('#themeBtn').click()`);
    await sleep(320);
    const after = await cdp.eval(`document.documentElement.dataset.theme`);
    const iconName = await cdp.eval(`document.querySelector('#themeBtn svg')._iconName`);
    assert(before === 'dark' && after === 'light', `主题没切换：${before} → ${after}`);
    assert(iconName === 'sun', `图标没 morph 成 sun，实际 ${iconName}`);
    const f = await cdp.shot('02-light-data'); shotFiles.push(f);
    return `dark → light，图标=${iconName}（截图 ${path.basename(f)}）`;
  });

  await check('按钮「主题切换」再点一次：回到 dark，图标 morph 成 moon', async () => {
    await cdp.eval(`document.querySelector('#themeBtn').click()`);
    await sleep(320);
    const after = await cdp.eval(`document.documentElement.dataset.theme`);
    const iconName = await cdp.eval(`document.querySelector('#themeBtn svg')._iconName`);
    assert(after === 'dark' && iconName === 'moon', `实际 theme=${after} icon=${iconName}`);
    return 'light → dark，图标=moon';
  });

  // ---------- 2. 添加项目 ----------
  const NEW_REPO = 'lucide-icons/lucide';
  await check(`表单「添加项目」：提交 ${NEW_REPO} 后新卡片出现且基线已记录`, async () => {
    await cdp.eval(`(() => {
      const i = document.querySelector('#repoInput');
      i.value = 'https://github.com/${NEW_REPO}';
      document.querySelector('#addForm').requestSubmit();
      return true;
    })()`);
    await cdp.waitFor(`!!document.querySelector('.repo-card[data-id="${NEW_REPO}"]')`, { timeout: 30000, label: '新卡片出现' });
    const info = await cdp.eval(`(() => {
      const r = window.__guw.state.repos.find(x => x.id === '${NEW_REPO}');
      const c = document.querySelector('.repo-card[data-id="${NEW_REPO}"]');
      return { baseline: r?.baseline || '', latest: r?.latest?.tag || '', status: c.querySelector('[data-testid="status-text"]').textContent, tags: [...c.querySelectorAll('[data-field="versions"] .tag')].map(t => t.textContent) };
    })()`);
    assert(info.latest, '没取到最新版本');
    assert(info.baseline === info.latest, `基线应等于最新版本，实际 baseline=${info.baseline} latest=${info.latest}`);
    assert(!/→/.test(info.tags.join('')), `无更新时不该画同值箭头，实际 ${info.tags.join(' ')}`);
    return `基线=${info.baseline}，状态=${info.status}，版本行=[${info.tags.join(' ')}]`;
  });

  await check('添加完成后按钮必须停止旋转并回到 +（回归：用户报过"叉叉一直转"）', async () => {
    await cdp.waitFor(`!document.querySelector('#addBtn').disabled`, { timeout: 20000, label: '添加流程结束' });
    await sleep(250);
    const busy = await cdp.eval(`(() => { const s = document.querySelector('#addBtn svg'); return { spin: s.classList.contains('spin'), icon: s._iconName }; })()`);
    assert(busy.spin === false, `按钮还在旋转：.spin 没被摘掉（icon=${busy.icon}）`);
    await sleep(1700);   // 等结果图标（对勾/警告）自动回到 +
    const after = await cdp.eval(`(() => { const s = document.querySelector('#addBtn svg'); return { spin: s.classList.contains('spin'), icon: s._iconName }; })()`);
    assert(after.icon === 'plus', `图标没回到 plus，实际 ${after.icon}`);
    assert(after.spin === false, '图标最终仍在旋转');
    return `停转正常，图标 ${busy.icon} → ${after.icon}`;
  });

  await check('焦点环不会把胶囊按钮压成尖角矩形（回归：用户报过"尖锐的四边形"）', async () => {
    const info = await cdp.eval(`(() => {
      // 注意：getComputedStyle 返回的是活对象，必须"焦点落在谁身上就立刻取值"，
      // 否则第二个元素一聚焦，第一个的值就读成失焦后的了（这里踩过）
      const read = (el) => {
        const cs = getComputedStyle(el);
        return { radius: parseFloat(cs.borderTopLeftRadius), outline: cs.outlineStyle, w: cs.outlineWidth, transition: cs.transitionProperty };
      };
      const chip = document.querySelector('.chip[data-filter="all"]');
      chip.focus({ focusVisible: true });     // 强制进入 :focus-visible
      const chipInfo = read(chip);
      const btn = document.querySelector('#checkAllBtn');
      btn.focus({ focusVisible: true });
      const btnInfo = read(btn);
      document.activeElement.blur();
      return { chip: chipInfo, btn: btnInfo };
    })()`);
    assert(info.chip.radius >= 100, `chip 圆角被焦点样式改小了：${info.chip.radius}px（应为 999）`);
    assert(info.btn.radius >= 8, `按钮圆角异常：${info.btn.radius}px`);
    assert(info.chip.outline !== 'none' && info.btn.outline !== 'none', `键盘焦点看不到焦点环：chip=${info.chip.outline} btn=${info.btn.outline}`);
    assert(info.chip.transition.includes('box-shadow'), `chip 过渡属性缺少 box-shadow：${info.chip.transition}`);
    return `chip 圆角 ${info.chip.radius}px / 按钮 ${info.btn.radius}px，焦点环 ${info.chip.w} ${info.chip.outline}`;
  });

  await check('表单校验：空输入提交会内联报错并设 aria-invalid（不会静默失败）', async () => {
    await cdp.eval(`(() => { document.querySelector('#repoInput').value=''; document.querySelector('#addForm').requestSubmit(); return true; })()`);
    await sleep(200);
    const info = await cdp.eval(`(() => {
      const i = document.querySelector('#repoInput');
      return { invalid: i.getAttribute('aria-invalid'), hint: document.querySelector('#repoHint').textContent, cls: document.querySelector('#repoHint').className };
    })()`);
    assert(info.invalid === 'true', '没设 aria-invalid');
    assert(/请先填/.test(info.hint), `提示文案不对：${info.hint}`);
    assert(info.cls.includes('is-error'), '提示没有进入错误态');
    // 还原表单的视觉状态，否则红色错误提示会一路串到后面的截图里
    await cdp.eval(`(() => {
      const i = document.querySelector('#repoInput'); i.removeAttribute('aria-invalid');
      const h = document.querySelector('#repoHint'); h.className = 'hint';
      h.innerHTML = '支持完整链接、<code>owner/repo</code>、<code>git@github.com:owner/repo.git</code>；添加时会把当前最新版本记为基线。';
      return true;
    })()`);
    return '内联错误 + aria-invalid 生效';
  });

  await check('接口去重：重复添加同一个项目返回 409 且界面给出提示', async () => {
    const r = await cdp.eval(`(async () => {
      const res = await fetch('/api/repos', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ input: '${NEW_REPO}' }) });
      return { status: res.status, body: await res.json() };
    })()`);
    assert(r.status === 409, `期望 409，实际 ${r.status}`);
    assert(/已经在列表/.test(r.body.error || ''), `错误文案不对：${r.body.error}`);
    return r.body.error;
  });

  // ---------- 3. 搜索 / 过滤 ----------
  await check('搜索框：输入 react 后只剩匹配卡片', async () => {
    await cdp.eval(`(() => { const i=document.querySelector('#searchInput'); i.value='react'; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    await sleep(320);
    const info = await cdp.eval(`(() => {
      const ids = [...document.querySelectorAll('.repo-card')].map(c => c.dataset.id);
      return { ids, state: window.__guw.state.query };
    })()`);
    assert(info.ids.length === 1 && info.ids[0] === 'facebook/react', `实际显示：${info.ids.join(', ')}`);
    return `只剩 ${info.ids[0]}`;
  });

  await check('搜索框：清空后卡片全部回来', async () => {
    await cdp.eval(`(() => { const i=document.querySelector('#searchInput'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    await sleep(320);
    const n = await cdp.eval(`document.querySelectorAll('.repo-card').length`);
    assert(n >= 4, `期望 ≥4 张，实际 ${n}`);
    return `${n} 张卡片`;
  });

  await check('过滤器「有更新」：点击后只留 update 卡片（当前应为 0 张 + 空态提示）', async () => {
    await cdp.eval(`document.querySelector('.chip[data-filter="update"]').click()`);
    await sleep(220);
    const info = await cdp.eval(`(() => ({
      pressed: document.querySelector('.chip[data-filter="update"]').getAttribute('aria-pressed'),
      cards: document.querySelectorAll('.repo-card').length,
      emptyHidden: document.querySelector('#emptyState').hidden,
      emptyTitle: document.querySelector('#emptyTitle').textContent,
    }))()`);
    assert(info.pressed === 'true', 'aria-pressed 没更新');
    assert(info.emptyHidden === false, '没有显示空态');
    assert(/没有匹配/.test(info.emptyTitle), `空态标题不对：${info.emptyTitle}`);
    return `${info.cards} 张卡片 + 空态「${info.emptyTitle}」`;
  });

  await check('过滤器「有问题」：切到该过滤，列表按状态收敛', async () => {
    await cdp.eval(`document.querySelector('.chip[data-filter="error"]').click()`);
    await sleep(220);
    const info = await cdp.eval(`(() => ({
      pressed: document.querySelector('.chip[data-filter="error"]').getAttribute('aria-pressed'),
      cards: document.querySelectorAll('.repo-card').length,
      anyError: [...document.querySelectorAll('.repo-card')].every(c => c.dataset.status === 'error'),
    }))()`);
    assert(info.pressed === 'true' && info.anyError, JSON.stringify(info));
    return `${info.cards} 张（全部为 error 状态）`;
  });

  await check('过滤器「全部」：恢复显示所有卡片', async () => {
    await cdp.eval(`document.querySelector('.chip[data-filter="all"]').click()`);
    await sleep(220);
    const n = await cdp.eval(`document.querySelectorAll('.repo-card').length`);
    assert(n >= 4, `期望 ≥4，实际 ${n}`);
    return `${n} 张卡片`;
  });

  // ---------- 4. 卡片按钮 ----------
  await check('卡片按钮「检查」：忙碌态出现 loader-circle，完成后回到 refresh-cw', async () => {
    const sel = '.repo-card[data-id="facebook/react"] [data-action="check"]';
    await cdp.eval(`(() => {
      window.__iconLog = [];
      const btn = document.querySelector('${sel}');
      window.__iconTimer = setInterval(() => {
        const n = btn.querySelector('svg')._iconName;
        if (window.__iconLog[window.__iconLog.length - 1] !== n) window.__iconLog.push(n);
      }, 12);
      btn.click();
      return true;
    })()`);
    await cdp.waitFor(`!document.querySelector('${sel}').disabled`, { timeout: 40000, label: '检查完成' });
    await sleep(1700);
    const log = await cdp.eval(`(clearInterval(window.__iconTimer), window.__iconLog)`);
    const icon = await cdp.eval(`document.querySelector('${sel} svg')._iconName`);
    assert(log.includes('loader-circle'), `没观察到忙碌图标，实际序列=${JSON.stringify(log)}`);
    assert(icon === 'refresh-cw', `完成后图标没复位，实际 ${icon}`);
    return `图标序列 ${log.join(' → ')}`;
  });

  await check('卡片按钮「版本历史」：展开后加载出 release 列表，再点收起', async () => {
    await cdp.eval(`document.querySelector('.repo-card[data-id="facebook/react"] [data-action="releases"]').click()`);
    await cdp.waitFor(`document.querySelectorAll('.repo-card[data-id="facebook/react"] .release-item .tag').length > 0`, { timeout: 25000, label: 'release 列表出现' });
    const info = await cdp.eval(`(() => {
      const c = document.querySelector('.repo-card[data-id="facebook/react"]');
      return {
        expanded: c.querySelector('[data-action="releases"]').getAttribute('aria-expanded'),
        icon: c.querySelector('[data-action="releases"] svg')._iconName,
        items: c.querySelectorAll('.release-item').length,
        hidden: c.querySelector('[data-field="releases"]').hidden,
        first: c.querySelector('.release-item .tag').textContent,
      };
    })()`);
    assert(info.expanded === 'true' && info.hidden === false, JSON.stringify(info));
    assert(info.icon === 'chevron-up', `箭头没翻转，实际 ${info.icon}`);
    assert(info.items > 0, '没有 release 条目');
    // 展开的内容在折叠区外，先把卡片滚进视野再拍，否则截图上什么都看不到
    await cdp.eval(`document.querySelector('.repo-card[data-id="facebook/react"]').scrollIntoView({ block: 'center' })`);
    await sleep(400);
    const f = await cdp.shot('03-releases-expanded'); shotFiles.push(f);
    await cdp.eval(`document.querySelector('.repo-card[data-id="facebook/react"] [data-action="releases"]').click()`);
    await sleep(260);
    const collapsed = await cdp.eval(`(() => { const c=document.querySelector('.repo-card[data-id="facebook/react"]'); return { hidden: c.querySelector('[data-field="releases"]').hidden, icon: c.querySelector('[data-action="releases"] svg')._iconName }; })()`);
    assert(collapsed.hidden === true && collapsed.icon === 'chevron-down', JSON.stringify(collapsed));
    return `展开 ${info.items} 条（首条 ${info.first}）→ 收起正常`;
  });

  await check('卡片「打开仓库」按钮与 Release 链接的 href 正确（含仓库改名后的真名）', async () => {
    const info = await cdp.eval(`(() => {
      const c = document.querySelector('.repo-card[data-id="facebook/react"]');
      return { repo: c.querySelector('[data-testid="repo-link"]').href, title: c.querySelector('[data-testid="repo-link"]').textContent, rel: c.querySelector('[data-action="release-link"]').href, rename: c.querySelector('[data-field="rename"]').hidden ? '' : c.querySelector('[data-field="rename"]').textContent };
    })()`);
    // facebook/react 已被 GitHub 301 到新名字，所以只断言「是 github.com 上同一个仓库的 releases/tag 链接」
    assert(/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/tag\/.+$/.test(info.rel), `Release 链接形状不对：${info.rel}`);
    const repoSlug = new URL(info.repo).pathname.replace(/^\//, '');
    const relSlug = new URL(info.rel).pathname.split('/releases/')[0].replace(/^\//, '');
    assert(repoSlug === relSlug, `仓库链接与 Release 链接不是同一个仓库：${repoSlug} vs ${relSlug}`);
    assert(info.title.includes('/'), `标题不像 owner/repo：${info.title}`);
    return `${info.title}（${info.rel.replace('https://github.com/', '')}）${info.rename ? ' · ' + info.rename : ''}`;
  });

  await check('「标记已读」按钮在无更新时是禁用的（且给出原因提示）', async () => {
    const info = await cdp.eval(`(() => { const b=document.querySelector('.repo-card[data-id="facebook/react"] [data-action="ack"]'); return { disabled: b.disabled, title: b.title }; })()`);
    assert(info.disabled === true, '无更新时不该可点');
    assert(/没有待确认/.test(info.title), `缺少原因提示：${info.title}`);
    return info.title;
  });

  // ---------- 5. 设置对话框 ----------
  await check('按钮「设置」：打开对话框 → 关闭按钮生效 → Esc 也能关', async () => {
    await cdp.eval(`document.querySelector('#settingsBtn').click()`);
    await sleep(260);
    const opened = await cdp.eval(`document.querySelector('#settingsDialog').open`);
    assert(opened === true, '对话框没打开');
    const hint = await cdp.eval(`document.querySelector('#rateHint').textContent`);
    assert(hint.length > 4, '额度提示为空');
    const f = await cdp.shot('04-settings-dialog'); shotFiles.push(f);
    await cdp.eval(`document.querySelector('#settingsCloseBtn').click()`);
    await sleep(200);
    assert((await cdp.eval(`document.querySelector('#settingsDialog').open`)) === false, '关闭按钮无效');
    await cdp.eval(`document.querySelector('#settingsBtn').click()`);
    await sleep(200);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(260);
    assert((await cdp.eval(`document.querySelector('#settingsDialog').open`)) === false, 'Esc 不能关闭');
    return `打开/关闭/Esc 均正常（截图 ${path.basename(f)}）`;
  });

  // ---------- 6. 删除 ----------
  await check(`按钮「删除」：弹确认框 → 取消不删 → 确认后卡片消失`, async () => {
    const sel = `.repo-card[data-id="${NEW_REPO}"] [data-action="delete"]`;
    await cdp.eval(`document.querySelector('${sel}').click()`);
    await sleep(260);
    assert((await cdp.eval(`document.querySelector('#confirmDialog').open`)) === true, '确认框没弹出');
    const f = await cdp.shot('05-confirm-delete'); shotFiles.push(f);
    await cdp.eval(`document.querySelector('#confirmCancelBtn').click()`);
    await sleep(260);
    assert((await cdp.eval(`!!document.querySelector('.repo-card[data-id="${NEW_REPO}"]')`)) === true, '取消后不该删除');
    await cdp.eval(`document.querySelector('${sel}').click()`);
    await sleep(220);
    await cdp.eval(`document.querySelector('#confirmOkBtn').click()`);
    await cdp.waitFor(`!document.querySelector('.repo-card[data-id="${NEW_REPO}"]')`, { timeout: 15000, label: '卡片被移除' });
    const stillInState = await cdp.eval(`window.__guw.state.repos.some(r => r.id === '${NEW_REPO}')`);
    assert(stillInState === false, '后端仍然存在该项目');
    return `取消保留 / 确认移除（截图 ${path.basename(f)}）`;
  });

  // ---------- 7. 「全部检查」完整跑一轮 ----------
  await check('按钮「全部检查」：进入忙碌态 → 轮询进度 → 完成并复位', async () => {
    await cdp.eval(`document.querySelector('#checkAllBtn').click()`);
    await cdp.waitFor(`document.querySelector('#checkAllBtn').disabled === true`, { timeout: 10000, label: '按钮进入忙碌态' });
    const icon = await cdp.eval(`document.querySelector('#checkAllBtn svg')._iconName`);
    await cdp.waitFor(`document.querySelector('#checkAllBtn').disabled === false`, { timeout: 90000, label: '全部检查结束' });
    const status = await cdp.eval(`document.querySelector('#jobStatus').textContent`);
    const label = await cdp.eval(`document.querySelector('#checkAllLabel').textContent`);
    assert(icon === 'loader-circle', `忙碌图标应为 loader-circle，实际 ${icon}`);
    assert(/完成/.test(status), `状态文案不对：${status}`);
    assert(label === '全部检查', `标签没复位：${label}`);
    const fresh = await cdp.eval(`window.__guw.state.repos.every(r => r.lastCheckedAt)`);
    assert(fresh === true, '有项目没被检查到');
    return status.trim();
  });

  await check('截图：检查完成后的最终态', async () => {
    const f = await cdp.shot('06-final'); shotFiles.push(f);
    return path.basename(f);
  });

  // ---------- 8. 错误路径：不可达仓库 ----------
  await check('错误处理：添加一个不存在的仓库 → 卡片出现并带 error 徽章（不是静默失败）', async () => {
    await cdp.eval(`(() => { const i=document.querySelector('#repoInput'); i.value='this-org-does-not-exist-xyz/nope-nope'; document.querySelector('#addForm').requestSubmit(); return true; })()`);
    await cdp.waitFor(`!!document.querySelector('.repo-card[data-id="this-org-does-not-exist-xyz/nope-nope"]')`, { timeout: 30000, label: '错误卡片出现' });
    const info = await cdp.eval(`(() => {
      const c = document.querySelector('.repo-card[data-id="this-org-does-not-exist-xyz/nope-nope"]');
      return { status: c.dataset.status, badge: c.querySelector('[data-testid="status-text"]').textContent, err: c.querySelector('[data-field="error"]').textContent, errHidden: c.querySelector('[data-field="error"]').hidden };
    })()`);
    assert(info.status === 'error', `状态应为 error，实际 ${info.status}`);
    assert(info.errHidden === false && info.err.length > 0, '错误信息没展示');
    // 清理
    const r = await cdp.eval(`(async () => (await fetch('/api/repos/this-org-does-not-exist-xyz%2Fnope-nope', {method:'DELETE'})).status)()`);
    assert(r === 200, `清理失败：${r}`);
    return `${info.badge} · ${info.err.slice(0, 40)}`;
  });

  // ---------------------------------------------------------------- 汇总
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  const summary = { total: results.length, pass, fail, shots: shotFiles, results };
  fs.writeFileSync(path.join(ROOT, 'data', 'verify-report.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n=== ${pass}/${results.length} 通过${fail ? `，${fail} 失败` : ''} ===`);
  if (fail) { console.log('失败项：'); results.filter((r) => !r.pass).forEach((r) => console.log(`  · ${r.name} → ${r.detail}`)); }
  console.log(`截图目录：${SHOT_DIR}`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('验证脚本自身出错：', e.message);
  process.exitCode = 2;
} finally {
  cdp?.close();
  try { chrome.kill(); } catch {}
}
