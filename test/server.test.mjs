/**
 * 服务端集成测试：Host 校验（DNS rebinding）+ Token 加密落盘 + 明文迁移。
 * 起的是真实 http server，只是数据目录指向临时目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SERVER = pathToFileURL(path.resolve(import.meta.dirname, '..', 'server.mjs')).href;

function request(port, { pathname = '/api/ping', host, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.host = host;                     // 覆盖 Node 默认的 Host
    if (body) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('Host 校验挡住 DNS rebinding；Token 只以密文落盘', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guw-srv-'));
  process.env.GUW_DATA_DIR = dir;
  const mod = await import('../server.mjs');
  const server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const ok = await request(port, { pathname: '/api/ping' });
  assert.equal(ok.status, 200, '正常 Host 应放行');
  assert.equal(JSON.parse(ok.text).mode, 'server');

  const evil = await request(port, { pathname: '/api/ping', host: 'evil.example' });
  assert.equal(evil.status, 403);
  assert.match(evil.text, /Host/);

  const evilStatic = await request(port, { pathname: '/', host: 'evil.example:1234' });
  assert.equal(evilStatic.status, 403, '静态资源同样要挡');

  const localhost = await request(port, { pathname: '/api/ping', host: `localhost:${port}` });
  assert.equal(localhost.status, 200, 'localhost 应放行');

  const token = 'ghp_test_token_1234567890';
  mod.store.setToken(token);
  const raw = fs.readFileSync(path.join(dir, 'repos.json'), 'utf8');
  assert.ok(raw.includes('enc:v1:'), 'repos.json 里应当是密文');
  assert.ok(!raw.includes(token), '明文 Token 不得出现在磁盘上');
  assert.equal(mod.store.settings.token, token, '内存里仍需明文（请求头要用）');
  assert.equal(mod.load().settings.token, token, 'load() 应能解回明文');
  assert.ok(fs.existsSync(path.join(dir, '.token-key')), '密钥文件应存在');
});

test('旧版本遗留在 repos.json 里的明文 Token 会在启动时迁移成密文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guw-mig-'));
  const file = path.join(dir, 'repos.json');
  fs.writeFileSync(file, JSON.stringify({ repos: [], settings: { token: 'ghp_legacy_plain_123' } }), 'utf8');

  const probe = `
    import fs from 'node:fs';
    const m = await import(process.env.__SERVER_URL);
    const raw = fs.readFileSync(process.env.__STORE_FILE, 'utf8');
    console.log(JSON.stringify({
      encrypted: raw.includes('enc:v1:'),
      plainOnDisk: raw.includes('ghp_legacy_plain_123'),
      inMemory: m.store.settings.token,
    }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GUW_DATA_DIR: dir,
      __SERVER_URL: SERVER,
      __STORE_FILE: file,
    },
    timeout: 30000,
  });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.encrypted, true, '启动后应变成密文');
  assert.equal(r.plainOnDisk, false, '磁盘上不该再有明文');
  assert.equal(r.inMemory, 'ghp_legacy_plain_123', '内存里仍可用');
  fs.rmSync(dir, { recursive: true, force: true });
});
