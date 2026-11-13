import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DATA = resolve(process.env.TARS_DATA_DIR || resolve(ROOT, '.tars-data'));
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const collections = ['departments', 'members', 'projects', 'documents', 'tasks', 'sessions', 'events', 'settings'];

export class Store extends EventEmitter {
  constructor() {
    super();
    mkdirSync(DATA, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(DATA, 'tars.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      PRAGMA user_version=1;`);
    this.getStmt = this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?');
    this.listStmt = this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC');
    this.saveStmt = this.db.prepare('INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body');
    this.depth = 0;
    if (!this.get('settings', 'main')) this.put('settings', { id: 'main', maxConcurrent: 2, maxSessionMinutes: 30 });
  }
  get(kind, key) {
    const row = this.getStmt.get(kind, key);
    return row ? JSON.parse(row.body) : null;
  }
  require(kind, key) {
    const row = this.get(kind, key);
    if (!row) throw Object.assign(new Error('항목을 찾을 수 없습니다.'), { statusCode: 404 });
    return row;
  }
  list(kind) { return this.listStmt.all(kind).map(row => JSON.parse(row.body)); }
  put(kind, record) {
    const value = { ...record, id: record.id || id(), updatedAt: now(), createdAt: record.createdAt || now() };
    this.saveStmt.run(kind, value.id, JSON.stringify(value));
    if (!this.depth) this.emit('change');
    return value;
  }
  patch(kind, key, values) { return this.put(kind, { ...this.require(kind, key), ...values, id: key }); }
  transaction(fn) {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
      this.emit('change');
    }
  }
  event(message, refs = {}) {
    this.put('events', { message, ...refs });
    this.db.prepare("DELETE FROM records WHERE kind='events' AND rowid NOT IN (SELECT rowid FROM records WHERE kind='events' ORDER BY rowid DESC LIMIT 500)").run();
  }
  snapshot() {
    const result = Object.fromEntries(collections.filter(k => k !== 'settings').map(k => [k, this.list(k)]));
    result.sessions = result.sessions.map(({ processToken, ...session }) => session);
    result.settings = this.get('settings', 'main');
    return result;
  }
}
