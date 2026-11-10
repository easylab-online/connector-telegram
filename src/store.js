import { uuid7 } from './id.js';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export class Store {
  constructor(path, key) {
    this.key = Buffer.from(key, 'base64');
    if (this.key.length !== 32) throw Error('MASTER_KEY must encode 32 bytes');
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS secrets(session TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session,name), FOREIGN KEY(session) REFERENCES sessions(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, body TEXT NOT NULL, tries INTEGER DEFAULT 0, due INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sends(session TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, PRIMARY KEY(session,key));`);
  }

  seal(value) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const b = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), b]).toString('base64');
  }

  open(value) {
    const b = Buffer.from(value, 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString();
  }

  secret(id, name, value) {
    if (value === undefined) {
      const r = this.db.prepare('SELECT value FROM secrets WHERE session=? AND name=?').get(id, name);
      return r ? this.open(r.value) : null;
    }
    if (value === null) this.db.prepare('DELETE FROM secrets WHERE session=? AND name=?').run(id, name);
    else this.db.prepare('INSERT OR REPLACE INTO secrets VALUES(?,?,?)').run(id, name, this.seal(value));
  }

  event(type, session, owner, data) {
    const id = uuid7();
    const body = JSON.stringify({
      id,
      type,
      sessionId: session,
      ownerId: owner,
      receivedAt: new Date().toISOString(),
      data,
    });
    this.db.prepare('INSERT INTO events(id,body,due) VALUES(?,?,?)').run(id, this.seal(body), Date.now());
    return id;
  }

  close() {
    this.db.close();
  }
}
