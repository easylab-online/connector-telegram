import { uuid7 } from './id.js';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { createHash, timingSafeEqual, createHmac } from 'node:crypto';
import { Store } from './store.js';
import { Service } from './service.js';
import { createTdlibDriver } from './tdlib/driver.js';

const { MASTER_KEY, CLIENTS_JSON, WEBHOOK_URL, WEBHOOK_SECRET } = process.env;
const clients = JSON.parse(CLIENTS_JSON ?? '[]');
if (!clients.length || clients.some(c => !c.ownerId || !c.token || c.token.length < 32)) {
  throw Error('Configure CLIENTS_JSON with ownerId and token (32+ characters)');
}
const insecureHttp = process.env.WEBHOOK_INSECURE_HTTP === '1';
const webhookUrl = WEBHOOK_URL ? new URL(WEBHOOK_URL) : null;
if (!webhookUrl || !WEBHOOK_SECRET || WEBHOOK_SECRET.length < 32) {
  throw Error('WEBHOOK_URL and 32+ character WEBHOOK_SECRET required');
}
if (
  webhookUrl.protocol !== 'https:' &&
  !(insecureHttp && webhookUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(webhookUrl.hostname))
) {
  throw Error('HTTPS WEBHOOK_URL required (or WEBHOOK_INSECURE_HTTP=1 with http://127.0.0.1/localhost)');
}

mkdirSync('./data', { recursive: true, mode: 0o700 });
const store = new Store('./data/connector.sqlite', MASTER_KEY);
const driver = await createTdlibDriver();
const svc = new Service(store, driver);

const digest = x => createHash('sha256').update(x).digest();
const tenantKeyRe = /^[a-z0-9][a-z0-9-]{0,59}$/;

function resolveOwner(client, tenantKey) {
  if (!client.multiTenant || tenantKey == null || tenantKey === '') return client.ownerId;
  const k = String(tenantKey).trim().toLowerCase();
  if (!tenantKeyRe.test(k)) throw Object.assign(Error('invalid_tenant_key'), { status: 400 });
  return `${client.ownerId}:${k}`;
}

function ownsOwner(client, owner) {
  return owner === client.ownerId || (client.multiTenant && owner.startsWith(`${client.ownerId}:`));
}

function ownedSession(client, id) {
  const s = store.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  if (!s || !ownsOwner(client, s.owner)) throw Object.assign(Error('session_not_found'), { status: 404 });
  return s;
}

function listSessions(client) {
  if (!client.multiTenant) return svc.list(client.ownerId);
  return store.db
    .prepare('SELECT id,active,owner FROM sessions WHERE owner=? OR owner LIKE ?')
    .all(client.ownerId, `${client.ownerId}:%`)
    .map(s => {
      const live = svc.driver.getLive(s.id);
      return {
        ...s,
        status: live?.status ?? 'stopped',
        linkedPhone: live?.linkedPhone ?? null,
        linkedUserId: live?.linkedUserId ?? null,
      };
    });
}

async function body(req) {
  let b = '';
  for await (const chunk of req) {
    b += chunk;
    if (Buffer.byteLength(b) > 65536) throw Object.assign(Error('body_too_large'), { status: 413 });
  }
  try {
    return JSON.parse(b || '{}');
  } catch {
    throw Object.assign(Error('invalid_json'), { status: 400 });
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const reply = (status, obj) => {
    res.writeHead(status);
    res.end(JSON.stringify(obj));
  };
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/health.json' && req.method === 'GET') {
      return reply(200, { version: '0.1.0', date: '2026-11-10', message: 'Telegram user connector running', driver: process.env.TDLIB_DRIVER ?? 'mock' });
    }
    if (path === '/' && req.method === 'GET') {
      return reply(200, {
        service: 'connector-telegram',
        version: '0.1.0',
        health: 'GET /health.json',
        api: 'Bearer token from CLIENTS_JSON',
        note: 'Link via Unified Inbox system → Channels → Telegram (account).',
      });
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const client = clients.find(c => timingSafeEqual(digest(c.token), digest(token)));
    if (!client) return reply(401, { error: 'unauthorized' });

    if (path === '/v1/sessions' && req.method === 'GET') return reply(200, { sessions: listSessions(client) });
    if (path === '/v1/sessions' && req.method === 'POST') {
      const payload = await body(req);
      const owner = resolveOwner(client, payload.tenantKey);
      const id = uuid7();
      store.db.prepare('INSERT INTO sessions(id,owner) VALUES(?,?)').run(id, owner);
      await svc.start(owner, id);
      return reply(201, { id, owner });
    }

    const match = path.match(/^\/v1\/sessions\/([a-f0-9-]{36})(?:\/(qr|phone|code|password|messages|logout|qr-confirm))?$/);
    if (!match) return reply(404, { error: 'not_found' });
    const [, id, action] = match;
    const owned = ownedSession(client, id);
    const owner = owned.owner;

    if (req.method === 'GET' && !action) {
      const live = svc.driver.getLive(id);
      return reply(200, { ...listSessions(client).find(s => s.id === id), owner, linkedPhone: live?.linkedPhone ?? null, status: live?.status ?? 'stopped' });
    }
    if (req.method === 'GET' && action === 'qr') return reply(200, svc.qr(id));
    if (req.method === 'POST' && action === 'phone') {
      const b = await body(req);
      if (typeof b.phone !== 'string') throw Object.assign(Error('phone_required'), { status: 400 });
      return reply(200, await svc.submitPhone(owner, id, b.phone.trim()));
    }
    if (req.method === 'POST' && action === 'code') {
      const b = await body(req);
      if (typeof b.code !== 'string') throw Object.assign(Error('code_required'), { status: 400 });
      return reply(200, await svc.submitCode(owner, id, b.code.trim()));
    }
    if (req.method === 'POST' && action === 'password') {
      const b = await body(req);
      if (typeof b.password !== 'string') throw Object.assign(Error('password_required'), { status: 400 });
      return reply(200, await svc.submitPassword(owner, id, b.password));
    }
    if (req.method === 'POST' && action === 'qr-confirm') {
      return reply(200, await svc.confirmQr(owner, id));
    }
    if (req.method === 'POST' && action === 'logout') {
      await svc.logout(owner, id);
      store.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      return reply(200, { ok: true });
    }
    if (req.method === 'POST' && action === 'messages') {
      const b = await body(req);
      if (typeof b.chatId !== 'string' || !b.chatId.trim() || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 10000) {
        throw Object.assign(Error('chat_id_and_text_required'), { status: 400 });
      }
      const out = await svc.send(owner, id, req.headers['idempotency-key'], { chatId: b.chatId.trim(), text: b.text });
      return reply(200, out);
    }
    return reply(405, { error: 'method_not_allowed' });
  } catch (e) {
    reply(e.status ?? 500, { error: e.status ? e.message : 'internal_error' });
  }
});

let delivering = false;
async function deliver() {
  if (delivering) return;
  delivering = true;
  try {
    const rows = store.db.prepare('SELECT * FROM events WHERE due<=? ORDER BY due LIMIT 25').all(Date.now());
    for (const row of rows) {
      try {
        const body = store.open(row.body);
        const stamp = String(Date.now());
        const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${stamp}.${body}`).digest('hex');
        const r = await fetch(WEBHOOK_URL, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-event-id': row.id,
            'x-timestamp': stamp,
            'x-signature': signature,
          },
          body,
          signal: AbortSignal.timeout(10000),
        });
        await r.body?.cancel();
        if (!r.ok) throw Error('delivery_failed');
        store.db.prepare('DELETE FROM events WHERE id=?').run(row.id);
      } catch {
        store.db
          .prepare('UPDATE events SET tries=tries+1,due=? WHERE id=?')
          .run(Date.now() + Math.min(300000, 1000 * 2 ** Math.min(row.tries, 8)) + Math.random() * 1000, row.id);
      }
    }
  } finally {
    delivering = false;
  }
}

const interval = setInterval(() => deliver().catch(() => {}), 1000);
for (const s of store.db.prepare('SELECT * FROM sessions WHERE active=1').all()) {
  await svc.start(s.owner, s.id).catch(() => {});
}
server.listen(Number(process.env.PORT ?? 3095), process.env.HOST ?? '127.0.0.1');

async function shutdown() {
  clearInterval(interval);
  server.close();
  await svc.shutdown();
  while (delivering) await new Promise(r => setTimeout(r, 50));
  store.close();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
