/**
 * 版本号同步工具 / 校验。
 *
 *   node tools/bump-version.mjs 1.0.3      # 同时改 package.json 与 public/version.js
 *   node tools/bump-version.mjs --check    # 只校验两者一致（CI 里跑）
 *
 * 为什么要两处：package.json 给 electron-builder 决定产物文件名，
 * public/version.js 给三端界面显示（安卓 APK 里也是同一份 public/）。
 * 分开写就有写歪的可能，所以 CI 必须校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'package.json');
const VER = path.join(ROOT, 'public', 'version.js');
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const readPkg = () => JSON.parse(fs.readFileSync(PKG, 'utf8'));
const readVer = () => {
  const m = fs.readFileSync(VER, 'utf8').match(/__GUW_VERSION\s*=\s*'([^']+)'/);
  return m ? m[1] : null;
};

const next = process.argv[2];
const isCheck = !next || next === '--check';

if (isCheck) {
  const pkgVersion = readPkg().version;
  const jsVersion = readVer();
  if (jsVersion === null) { console.error('public/version.js 里找不到 __GUW_VERSION'); process.exit(1); }
  if (pkgVersion !== jsVersion) {
    console.error(`版本号不一致：package.json=${pkgVersion}，public/version.js=${jsVersion}`);
    console.error('用 node tools/bump-version.mjs <版本> 一起改。');
    process.exit(1);
  }
  console.log(`版本号一致：${pkgVersion}`);
  process.exit(0);
}

if (!SEMVER.test(next)) { console.error(`版本号格式不对：${next}`); process.exit(1); }

// package.json：用 JSON 解析/序列化，避免手改字符串（也避免被 PowerShell 写进 BOM）
const pkg = readPkg();
const before = pkg.version;
pkg.version = next;
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

const verSrc = fs.readFileSync(VER, 'utf8').replace(/__GUW_VERSION\s*=\s*'[^']+'/, `__GUW_VERSION = '${next}'`);
fs.writeFileSync(VER, verSrc, 'utf8');

console.log(`版本号 ${before} → ${next}（package.json + public/version.js 已同步）`);
