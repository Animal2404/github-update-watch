// 验证「Windows 路径直接喂给 import() 会炸」这个根因，以及 pathToFileURL 的修法。
// 这是打包后 EXE 一启动就死的直接原因。
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'esm-path-'));
const target = path.join(dir, 'mod.mjs');
writeFileSync(target, 'export const ok = "模块加载成功";\n', 'utf8');
console.log('目标模块:', target);

let bad = null;
try {
  const m = await import(target);            // ← 打包后 electron/main.mjs 原来就是这么写的
  console.log('❌ 直接传路径居然成功了:', m.ok);
} catch (e) {
  bad = e;
  console.log('✅ 直接传路径失败（复现了线上故障）:', e.code || e.name, '-', String(e.message).split('\n')[0]);
}

let good = null;
try {
  const m = await import(pathToFileURL(target).href);
  good = m.ok;
  console.log('✅ pathToFileURL 后成功:', m.ok);
} catch (e) {
  console.log('❌ pathToFileURL 也失败:', e.message);
}

console.log('');
console.log(bad && good
  ? '结论：根因确认 = import() 把 "C:\\..." 当成了 URL 协议；修法有效 = 用 pathToFileURL。'
  : '结论：与预期不符，需要重新排查。');
process.exit(bad && good ? 0 : 1);
