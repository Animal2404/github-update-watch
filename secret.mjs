/**
 * GitHub 更新监测 · 密钥与令牌加密（Node 侧专用，不进浏览器）
 * ---------------------------------------------------------------------------
 * 目标很具体：**别让 repos.json 单独泄露 Token**。
 *   · 备份/同步 data/ 目录时，repos.json 里只有密文；
 *   · 误把 data/ 传上 GitHub 时，泄露的也只是密文。
 *
 * 明确**不是**什么：
 *   · 不是系统钥匙串。密钥就放在同目录的 .token-key（0600），同用户权限下的进程
 *     仍然能同时读到密钥和密文。要抗"同账号恶意软件"得上 DPAPI/Keychain/DPAPI，
 *     那需要平台 API 或额外依赖，与"零外部依赖"冲突，所以不做，并在 README 里写明。
 *
 * 格式：`enc:v1:<base64(iv(12) | tag(16) | ciphertext)>`（AES-256-GCM）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ENC_PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * @param {{ keyFile: string, warn?: (msg: string) => void }} opts
 */
export function createSecretStore({ keyFile, warn = () => {} }) {
  let key = null;

  function loadKey() {
    if (key) return key;
    try {
      const raw = fs.readFileSync(keyFile);
      if (raw.length === KEY_BYTES) { key = raw; return key; }
      warn(`密钥文件长度异常（${raw.length} 字节），将重新生成；已有密文将无法解密`);
    } catch (e) {
      if (e.code !== 'ENOENT') warn('读取密钥文件失败：' + e.message);
    }
    const fresh = crypto.randomBytes(KEY_BYTES);
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    try {
      // wx：并发实例不会互相覆盖，谁先创建谁生效
      fs.writeFileSync(keyFile, fresh, { mode: 0o600, flag: 'wx' });
      key = fresh;
    } catch (e) {
      if (e.code === 'EEXIST') {
        key = fs.readFileSync(keyFile);
        if (key.length !== KEY_BYTES) { key = null; warn('密钥文件损坏'); }
      } else {
        throw e;
      }
    }
    // Windows 上 chmod 基本是 no-op（NTFS ACL），其它平台才真正生效
    try { fs.chmodSync(keyFile, 0o600); } catch { /* 忽略 */ }
    return key;
  }

  /** @returns {string} 空字符串原样返回，避免把"没有 Token"也加密成一坨 */
  function encrypt(plain) {
    const text = String(plain ?? '');
    if (!text) return '';
    if (isEncrypted(text)) return text;          // 已经是密文就不再包一层
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, loadKey(), iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  /** 解密失败（密钥丢了/文件被换过）返回 null —— 调用方按"没有 Token"处理，不崩 */
  function decrypt(stored) {
    const text = String(stored ?? '');
    if (!text) return '';
    if (!isEncrypted(text)) return text;
    try {
      const buf = Buffer.from(text.slice(ENC_PREFIX.length), 'base64');
      const iv = buf.subarray(0, IV_BYTES);
      const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const body = buf.subarray(IV_BYTES + TAG_BYTES);
      const decipher = crypto.createDecipheriv(ALGO, loadKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch (e) {
      warn('Token 解密失败（密钥不匹配或密文损坏），已按未设置 Token 处理：' + e.message);
      return null;
    }
  }

  return { keyFile, encrypt, decrypt, isEncrypted };
}
