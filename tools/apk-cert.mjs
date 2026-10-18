#!/usr/bin/env node
/**
 * 读取 APK 的 v2 签名证书 SHA-256（冒号分隔大写）。
 * 为什么不依赖 apksigner：CI 上它可能不在 PATH/ANDROID_HOME 未导出，解析失败会让守卫误报"证书为空"。
 * 这个脚本只做一件事：定位 APK Signing Block 里的 v2 block（0x7109871a）并取第一张证书。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = process.argv[2];
if (!file) { console.error('用法: node tools/apk-cert.mjs <apk>'); process.exit(2); }
const apk = readFileSync(file);

let eocd = -1;
for (let i = apk.length - 22; i >= Math.max(0, apk.length - 70000); i--) {
  if (apk.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.error('不是合法 APK：找不到 EOCD'); process.exit(1); }

const cdOffset = apk.readUInt32LE(eocd + 16);
const blockSize = Number(apk.readBigUInt64LE(cdOffset - 24));
const blockStart = cdOffset - blockSize;
const pairsEnd = cdOffset - 24;

let v2 = null;
for (let p = blockStart; p < pairsEnd;) {
  const len = Number(apk.readBigUInt64LE(p));
  const id = apk.readUInt32LE(p + 8);
  if (id === 0x7109871a) v2 = apk.subarray(p + 12, p + 8 + len);
  p += 8 + len;
}
if (!v2) { console.error('APK 没有 v2 签名块（可能是 v1-only / 未签名）'); process.exit(1); }

function lp(buf, off) {
  const len = buf.readUInt32LE(off);
  return { data: buf.subarray(off + 4, off + 4 + len), next: off + 4 + len };
}
const signers = lp(v2, 0);
const signer = lp(signers.data, 0);
const signedData = lp(signer.data, 0);
const digests = lp(signedData.data, 0);
const certs = lp(signedData.data, digests.next);
const cert = lp(certs.data, 0);
const hex = createHash('sha256').update(cert.data).digest('hex').toUpperCase();
console.log(hex.match(/../g).join(':'));
