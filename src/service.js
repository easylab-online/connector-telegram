import { createHash } from 'node:crypto';
import { qrPayloadFromLive } from './tdlib/mock-driver.js';

export class Service {
  constructor(store, driver) {
    this.store = store;
    this.driver = driver;
    this.live = new Map();
    this.owners = new Map();
    driver.onUpdate((sessionId, type, data) => this._onDriverUpdate(sessionId, type, data));
  }

  owned(owner, id) {
    const row = this.store.db.prepare('SELECT owner FROM sessions WHERE id=?').get(id);
    if (!row || row.owner !== owner) throw Object.assign(Error('session_not_found'), { status: 404 });
    this.owners.set(id, owner);
    return row;
  }

  list(owner) {
    return this.store.db
      .prepare('SELECT id,active,owner FROM sessions WHERE owner=?')
      .all(owner)
      .map(s => {
        const live = this.driver.getLive(s.id);
        return { ...s, status: live?.status ?? 'stopped', linkedPhone: live?.linkedPhone ?? null };
      });
  }

  async start(owner, id) {
    this.owned(owner, id);
    await this.driver.startSession(id);
    this._refreshLive(id);
    return this.live.get(id);
  }

  async stop(owner, id) {
    this.owned(owner, id);
    await this.driver.stopSession(id);
    this._refreshLive(id);
  }

  async submitPhone(owner, id, phone) {
    this.owned(owner, id);
    await this.driver.submitPhone(id, phone);
    this._refreshLive(id);
    const s = this.live.get(id);
    return s;
  }

  async submitCode(owner, id, code) {
    this.owned(owner, id);
    await this.driver.submitCode(id, code);
    this._refreshLive(id);
    return this.live.get(id);
  }

  async submitPassword(owner, id, password) {
    this.owned(owner, id);
    await this.driver.submitPassword(id, password);
    this._refreshLive(id);
    return this.live.get(id);
  }

  async confirmQr(owner, id) {
    this.owned(owner, id);
    if (this.driver.confirmQr) await this.driver.confirmQr(id);
    this._refreshLive(id);
    return this.live.get(id);
  }

  qr(id) {
    const live = this.driver.getLive(id);
    return { qr: qrPayloadFromLive(live), status: live?.status ?? 'stopped' };
  }

  async send(owner, id, key, content) {
    this.owned(owner, id);
    if (!key || key.length > 128) throw Object.assign(Error('idempotency_key_required'), { status: 400 });
    const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    const prior = this.store.db.prepare('SELECT * FROM sends WHERE session=? AND key=?').get(id, key);
    if (prior) {
      if (prior.hash !== hash) throw Object.assign(Error('idempotency_conflict'), { status: 409 });
      return { state: prior.state, result: prior.result ? JSON.parse(this.store.open(prior.result)) : null };
    }
    const result = await this.driver.sendMessage(id, content);
    const state = result?.state ?? 'submitted';
    this.store.db
      .prepare('INSERT INTO sends(session,key,hash,state,result) VALUES(?,?,?,?,?)')
      .run(id, key, hash, state, this.store.seal(JSON.stringify(result)));
    return { state, result };
  }

  async logout(owner, id) {
    this.owned(owner, id);
    await this.driver.logout(id);
    this.store.db.prepare('DELETE FROM secrets WHERE session=?').run(id);
    this.live.delete(id);
  }

  async shutdown() {
    /* driver-specific cleanup if needed */
  }

  _refreshLive(id) {
    const live = this.driver.getLive(id);
    this.live.set(id, live);
  }

  _onDriverUpdate(sessionId, type, data) {
    const owner = this.store.db.prepare('SELECT owner FROM sessions WHERE id=?').get(sessionId)?.owner;
    if (!owner) return;
    this._refreshLive(sessionId);
    if (type === 'message.upsert') {
      this.store.event('message.upsert', sessionId, owner, data);
    } else if (type === 'connection.open') {
      this.store.event('connection.open', sessionId, owner, data);
    } else if (type === 'connection.closed') {
      this.store.event('connection.closed', sessionId, owner, data);
    }
  }
}
