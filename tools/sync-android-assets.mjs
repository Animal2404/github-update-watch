/**
 * 把网页资源同步进安卓工程的 assets。
 *
 *   node tools/sync-android-assets.mjs
 *
 * 为什么不放在 Gradle 里做：写进 sourceSets 的源码目录会触发 Gradle 8.x 的
 * 任务依赖校验（"uses this output ... without declaring an explicit or implicit dependency"），
 * 让 lintVitalRelease 直接失败。显式同步一次更简单也更透明——APK 里就是此刻的 public/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public');
const DST = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www');

fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });

let files = 0;
let bytes = 0;
function copyDir(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
      files++;
      bytes += fs.statSync(d).size;
    }
  }
}
copyDir(SRC, DST);

const required = ['index.html', 'app.js', 'styles.css', 'github-core.js',
  path.join('vendor', 'icons.js'), path.join('vendor', 'morphicons', 'dom.js')];
const missing = required.filter((f) => !fs.existsSync(path.join(DST, f)));
if (missing.length) {
  console.error(`同步后缺少关键文件：${missing.join(', ')}`);
  process.exit(1);
}

console.log(`同步完成：${files} 个文件 / ${(bytes / 1024).toFixed(1)} KB → ${path.relative(ROOT, DST)}`);
