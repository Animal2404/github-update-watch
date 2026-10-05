/**
 * 构建期工具：把 lucide-static 的 SVG 图标转成 morphicons 吃的 IconNode 数据。
 *
 *   node tools/build-icons.mjs <lucide/icons 目录> <输出 icons.js> [morphicons/dist 目录]
 *
 * 为什么要在构建期做转换：
 *  - morphicons 只吃「数据」（IconNode 或裸 d 字符串），不吃 SVG 标记；
 *  - 浏览器的 d 字符串最稳，所以这里把 circle/rect/line/polyline/polygon/ellipse
 *    全部展开成 path 的 d（morphicons 兼容性四条件之一：只允许 7 种描边图元）；
 *  - 传第三个参数时，会用它自己的 resampleIcon 逐个解析，解析不了的图标直接构建失败——
 *    这样「图标能不能 morph」在构建期就有答案，而不是等到界面里飞出去才发现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , iconsDir, outFile, morphDist] = process.argv;
if (!iconsDir || !outFile) {
  console.error('usage: node build-icons.mjs <lucide/icons dir> <out icons.js> [morphicons/dist]');
  process.exit(2);
}

const NAMES = [
  'refresh-cw', 'loader-circle', 'check', 'check-check', 'circle-check', 'circle-alert',
  'triangle-alert', 'plus', 'x', 'trash-2', 'sun', 'moon', 'external-link', 'search',
  'inbox', 'chevron-down', 'chevron-up', 'settings-2', 'rotate-ccw', 'tag', 'clock',
  'star', 'book-open', 'folder-open', 'rss', 'filter', 'activity', 'info', 'wifi-off',
  'ellipsis', 'copy', 'arrow-up-right', 'circle-x', 'git-branch', 'package',
];

const num = (v) => Number(v);
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

/** 圆 → 两段圆弧的 path */
function circleToD(a) {
  const cx = num(a.cx), cy = num(a.cy), r = num(a.r);
  return `M ${fmt(cx - r)} ${fmt(cy)} a ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2 * r)} 0 a ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2 * r)} 0`;
}
function ellipseToD(a) {
  const cx = num(a.cx), cy = num(a.cy), rx = num(a.rx), ry = num(a.ry);
  return `M ${fmt(cx - rx)} ${fmt(cy)} a ${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(2 * rx)} 0 a ${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(-2 * rx)} 0`;
}
function rectToD(a) {
  const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
  const rx = Math.min(num(a.rx || 0), w / 2);
  const ry = Math.min(num(a.ry || a.rx || 0), h / 2);
  if (!rx && !ry) {
    return `M ${fmt(x)} ${fmt(y)} H ${fmt(x + w)} V ${fmt(y + h)} H ${fmt(x)} Z`;
  }
  return `M ${fmt(x + rx)} ${fmt(y)} H ${fmt(x + w - rx)} A ${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x + w)} ${fmt(y + ry)} ` +
    `V ${fmt(y + h - ry)} A ${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x + w - rx)} ${fmt(y + h)} ` +
    `H ${fmt(x + rx)} A ${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x)} ${fmt(y + h - ry)} ` +
    `V ${fmt(y + ry)} A ${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x + rx)} ${fmt(y)} Z`;
}
function pointsToD(points, close) {
  const pts = String(points).trim().split(/[\s,]+/).map(Number);
  const pairs = [];
  for (let i = 0; i + 1 < pts.length; i += 2) pairs.push([pts[i], pts[i + 1]]);
  if (!pairs.length) return '';
  return 'M ' + pairs.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(' L ') + (close ? ' Z' : '');
}

function parseAttrs(raw) {
  const out = {};
  // 注意 [a-zA-Z-]+ 会漏掉 x1/y1/x2/y2 这类带数字的属性名（踩过：生成出 M NaN NaN）
  for (const m of raw.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** SVG 文本 → IconNode（统一成 [{ d }] 形式） */
function svgToIcon(svg) {
  const shape = /<(path|circle|ellipse|rect|line|polyline|polygon)\b([^>]*?)\/?>/g;
  const nodes = [];
  for (const m of svg.matchAll(shape)) {
    const tag = m[1];
    const a = parseAttrs(m[2]);
    let d = null;
    if (tag === 'path') d = a.d;
    else if (tag === 'circle') d = circleToD(a);
    else if (tag === 'ellipse') d = ellipseToD(a);
    else if (tag === 'rect') d = rectToD(a);
    else if (tag === 'line') d = `M ${fmt(num(a.x1))} ${fmt(num(a.y1))} L ${fmt(num(a.x2))} ${fmt(num(a.y2))}`;
    else if (tag === 'polyline') d = pointsToD(a.points, false);
    else if (tag === 'polygon') d = pointsToD(a.points, true);
    if (d) {
      // 静默产出 NaN 的图标比报错更危险（上线才发现形状是空的），这里直接拦死
      if (/NaN|undefined/.test(d)) throw new Error(`${name || tag}: 生成的 d 含 NaN/undefined → ${d}`);
      nodes.push(['path', { d }]);
    }
  }
  if (!nodes.length) throw new Error('没有解析出任何描边图元');
  return nodes;
}

// ---------------------------------------------------------------- 生成
const icons = {};
const missing = [];
for (const name of NAMES) {
  const file = path.join(iconsDir, `${name}.svg`);
  if (!fs.existsSync(file)) { missing.push(name); continue; }
  icons[name] = svgToIcon(fs.readFileSync(file, 'utf8'));
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
const banner = `// 由 tools/build-icons.mjs 生成，请勿手改。\n// 源：lucide-static（ISC License）+ 构建期把 circle/rect/line/polyline/polygon 展开为 path d。\n`;
fs.writeFileSync(outFile,
  banner +
  `export const icons = ${JSON.stringify(icons, null, 1)};\n\n` +
  `export const iconNames = ${JSON.stringify(Object.keys(icons))};\n`,
  'utf8');

console.log(`生成 ${Object.keys(icons).length} 个图标 → ${outFile}`);
if (missing.length) console.log(`缺失（已跳过）：${missing.join(', ')}`);

// ---------------------------------------------------------------- 自检
if (morphDist) {
  const core = await import(pathToFileURL(path.join(morphDist, 'index.js')).href);
  const bad = [];
  for (const [name, icon] of Object.entries(icons)) {
    try {
      const s = core.resampleIcon(icon);
      if (!s || !s.length) throw new Error('重采样结果为空');
    } catch (e) { bad.push(`${name}: ${e.message}`); }
  }
  const chain = ['refresh-cw', 'moon', 'circle-check'];
  try {
    const plan = core.buildPlan(core.resampleIcon(icons[chain[0]]), core.resampleIcon(icons[chain[1]]));
    console.log(`morph 计划自检：${chain[0]} → ${chain[1]} 生成 ${plan.items.length} 条子路径`);
  } catch (e) { bad.push(`buildPlan 失败: ${e.message}`); }

  if (bad.length) { console.error('自检失败：\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log(`自检通过：${Object.keys(icons).length} 个图标均可被 morphicons 解析`);
}
