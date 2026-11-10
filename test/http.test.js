import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const token = randomBytes(32).toString('hex');
const secret = randomBytes(32).toString('hex');
const masterKey = randomBytes(32).toString('base64');

test('session auth mock + send', async () => {
  const hook = createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c;
    res.writeHead(200);
    res.end('{}');
  });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  const port = 31995;
  const env = {
    ...process.env,
    TDLIB_DRIVER: 'mock',
    MOCK_OTP: '42424',
    MASTER_KEY: masterKey,
    PORT: String(port),
    HOST: '127.0.0.1',
    CLIENTS_JSON: JSON.stringify([{ ownerId: 'test', token, multiTenant: false }]),
    WEBHOOK_URL: `http://127.0.0.1:${hookPort}/hook`,
    WEBHOOK_SECRET: secret,
    WEBHOOK_INSECURE_HTTP: '1',
  };
  const child = spawn(process.execPath, ['src/main.js'], { cwd: root, env, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 500));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const base = `http://127.0.0.1:${port}`;
  try {
    const create = await fetch(`${base}/v1/sessions`, { method: 'POST', headers });
    assert.equal(create.status, 201);
    const { id } = await create.json();
    const phone = await fetch(`${base}/v1/sessions/${id}/phone`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: '+96890001111' }),
    });
    assert.equal(phone.status, 200);
    const bad = await fetch(`${base}/v1/sessions/${id}/code`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ code: '11111' }),
    });
    assert.equal(bad.status, 400);
    const code = await fetch(`${base}/v1/sessions/${id}/code`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ code: '42424' }),
    });
    assert.equal(code.status, 200);
    const st = await (await fetch(`${base}/v1/sessions/${id}`, { headers })).json();
    assert.equal(st.status, 'open');
    const send = await fetch(`${base}/v1/sessions/${id}/messages`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'k1' },
      body: JSON.stringify({ chatId: '100', text: 'hello' }),
    });
    assert.equal(send.status, 200);
  } finally {
    child.kill('SIGTERM');
    hook.close();
  }
});
