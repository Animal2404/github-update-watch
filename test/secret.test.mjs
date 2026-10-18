import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSecretStore, isEncrypted, ENC_PREFIX } from '../secret.mjs';

function tmpKeyFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guw-secret-'));
  return { dir, keyFile: path.join(dir, '.token-key') };
}

test('Token 加密：往返一致、空值不加密、二次加密幂等', () => {
  const { dir, keyFile } = tmpKeyFile();
  const s = createSecretStore({ keyFile });
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const enc = s.encrypt(token);
  assert.ok(enc.startsWith(ENC_PREFIX), enc.slice(0, 12));
  assert.notEqual(enc, token);
  assert.equal(s.decrypt(enc), token);
  assert.equal(s.encrypt(''), '');
  assert.equal(s.decrypt(''), '');
  assert.equal(s.encrypt(enc), enc, '已经是密文就不该再包一层');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Token 加密：密文被篡改 / 换密钥后解密返回 null（按未设置处理，不抛）', () => {
  const a = tmpKeyFile();
  const s1 = createSecretStore({ keyFile: a.keyFile });
  const enc = s1.encrypt('ghp_secret_value');
  const buf = Buffer.from(enc.slice(ENC_PREFIX.length), 'base64');
  buf[buf.length - 1] ^= 0xff;                       // 改密文最后一个字节
  const tampered = ENC_PREFIX + buf.toString('base64');
  assert.notEqual(tampered, enc);
  assert.equal(s1.decrypt(tampered), null);

  const b = tmpKeyFile();
  const s2 = createSecretStore({ keyFile: b.keyFile });   // 另一把密钥
  const warnings = [];
  const s3 = createSecretStore({ keyFile: b.keyFile, warn: (m) => warnings.push(m) });
  assert.equal(s3.decrypt(enc), null);
  assert.equal(warnings.length, 1, '解密失败必须留痕');
  fs.rmSync(a.dir, { recursive: true, force: true });
  fs.rmSync(b.dir, { recursive: true, force: true });
});

test('isEncrypted 只认自己的前缀', () => {
  assert.equal(isEncrypted('enc:v1:abc'), true);
  assert.equal(isEncrypted('ghp_plain'), false);
  assert.equal(isEncrypted(null), false);
  assert.equal(isEncrypted(''), false);
});
