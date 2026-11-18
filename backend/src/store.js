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
export const collections = ['departments', 'members', 'projects', 'documents', 'tasks', 'sessions', 'conversations', 'events', 'settings', 'requests', 'taskReports', 'taskReviews', 'workflowJobs', 'workApprovals', 'inputRequests', 'chatQueue'];

export class Store extends EventEmitter {
  constructor() {
    super();
    mkdirSync(DATA, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(DATA, 'tars.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS work_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
        task_id TEXT, session_id TEXT, member_id TEXT, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_entity ON work_history(kind, entity_id, sequence);
      CREATE INDEX IF NOT EXISTS history_task ON work_history(task_id, sequence);
      CREATE INDEX IF NOT EXISTS history_session ON work_history(session_id, sequence);
      CREATE INDEX IF NOT EXISTS history_member ON work_history(member_id, sequence);
      PRAGMA user_version=2;`);
    this.getStmt = this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?');
    this.listStmt = this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC');
    this.saveStmt = this.db.prepare('INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body');
    this.depth = 0;
    this.cache = new Map();
    this.dataVersion = this.db.prepare("PRAGMA data_version");
    this.cacheVersion = null;
    this.quiet = false;
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
  list(kind) {
    const version = this.dataVersion.get().data_version;
    if (version !== this.cacheVersion) { this.cache.clear(); this.cacheVersion = version; }
    if (!this.cache.has(kind)) this.cache.set(kind, this.listStmt.all(kind).map(row => JSON.parse(row.body)));
    return structuredClone(this.cache.get(kind));
  }
  patchProgress(sessionId, values) {
    this.quiet = true;
    try { return this.transaction(() => this.patch('sessions', sessionId, typeof values === 'function' ? values() : values)); }
    finally { this.quiet = false; this.emit('session-progress', sessionId); }
  }
  put(kind, record, { actor = 'system' } = {}) {
    const tracked = ['tasks', 'sessions', 'members', 'requests'].includes(kind);
    // The current state and its history are committed together, including nested plans.
    if (tracked && !this.depth) return this.transaction(() => this.put(kind, record, { actor }));
    const previous = tracked && record.id ? this.get(kind, record.id) : null;
    const value = { ...record, id: record.id || id(), updatedAt: now(), createdAt: record.createdAt || now() };
    this.saveStmt.run(kind, value.id, JSON.stringify(value));
    this.cache.delete(kind);
    if (tracked) this.recordChanges(kind, previous, value, actor);
    if (!this.depth && !this.quiet) this.emit('change');
    return value;
  }
  patch(kind, key, values, options) { return this.put(kind, { ...this.require(kind, key), ...values, id: key }, options); }
  delete(kind, key) {
    const value = this.require(kind, key);
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, key);
    this.cache.delete(kind);
    if (!this.depth && !this.quiet) this.emit('change');
    return value;
  }
  recordChanges(kind, previous, value, actor) {
    const refs = { kind, entityId: value.id, actor,
      taskId: kind === 'tasks' ? value.id : value.taskId || null,
      sessionId: kind === 'sessions' ? value.id : value.currentSessionId || value.sessionId || null,
      memberId: kind === 'members' ? value.id : value.memberId || value.assigneeId || null };
    if (!previous || previous.status !== value.status) this.appendHistory({ ...refs, event: 'status',
      fromStatus: previous?.status || null, status: value.status,
      message: value.error || value.progress || (previous ? '상태 변경' : '기록 생성') });
    else if (kind === 'sessions' && previous.progress !== value.progress) this.appendHistory({ ...refs, event: 'progress', status: value.status, message: value.progress });
    if (kind === 'sessions' && value.activityNote && previous?.activityNote !== value.activityNote) {
      this.appendHistory({ ...refs, actor: value.memberId, event: 'note', status: value.status, message: value.activityNote });
    }
    if (kind === 'sessions') for (const input of (value.steering || []).slice(previous?.steering?.length || 0)) {
      this.appendHistory({ ...refs, actor: 'user', event: 'instruction', message: '실행 중 추가 지시', details: { prompt: input.prompt } });
    }
    if (kind === 'tasks' && previous) {
      if (previous.assigneeId !== value.assigneeId) this.appendHistory({ ...refs, event: 'assignment', message: '담당자 변경',
        details: { from: previous.assigneeId, to: value.assigneeId } });
      const changes = Object.fromEntries(['title', 'description', 'acceptance', 'dependsOn', 'documentIds', 'priority', 'projectId', 'departmentId', 'isolation', 'goalId', 'plannedUnits']
        .filter(key => JSON.stringify(previous[key]) !== JSON.stringify(value[key]))
        .map(key => [key, { from: previous[key], to: value[key] }]));
      if (Object.keys(changes).length) this.appendHistory({ ...refs, event: 'edited', message: '작업 내용 수정', details: changes });
      if (previous.integratedAt !== value.integratedAt && value.integratedAt) this.appendHistory({ ...refs, event: 'integrated', message: '원본에 변경 적용' });
    }
    if (kind === 'requests' && previous && JSON.stringify(previous.progressPlan) !== JSON.stringify(value.progressPlan)) {
      this.appendHistory({ ...refs, event: 'progress_plan', message: '달성 목표·수량·비중 변경',
        details: { from: previous.progressPlan || null, to: value.progressPlan || null } });
    }
  }
  appendHistory(entry) {
    const body = { ...entry, at: now(), message: String(entry.message || '').slice(0, 2000) };
    this.db.prepare('INSERT INTO work_history(kind,entity_id,task_id,session_id,member_id,body) VALUES(?,?,?,?,?,?)')
      .run(entry.kind, entry.entityId, entry.taskId || null, entry.sessionId || null, entry.memberId || null, JSON.stringify(body));
    if (!this.depth && !this.quiet) this.emit('change');
  }
  history(kind, key, { before = null, limit = 50 } = {}) {
    const column = { tasks: 'task_id', sessions: 'session_id', members: 'member_id' }[kind];
    if (!column) throw new Error('지원하지 않는 이력 종류입니다.');
    const where = `((${column}=?) OR (kind=? AND entity_id=?))`;
    const rows = this.db.prepare(`SELECT sequence,body FROM work_history WHERE ${where} AND sequence < ? ORDER BY sequence DESC LIMIT ?`)
      .all(key, kind, key, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM work_history WHERE ${where}`).get(key, kind, key).count;
    const events = rows.slice(0, limit).map(row => ({ ...JSON.parse(row.body), sequence: row.sequence }));
    return { events, total, nextBefore: rows.length > limit ? events.at(-1).sequence : null };
  }
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
      this.cache.clear();
      throw error;
    } finally {
      this.depth--;
      if (!this.quiet) this.emit('change');
    }
  }
  event(message, refs = {}) {
    this.put('events', { message, ...refs });
    this.db.prepare("DELETE FROM records WHERE kind='events' AND rowid NOT IN (SELECT rowid FROM records WHERE kind='events' ORDER BY rowid DESC LIMIT 500)").run();
    this.cache.delete('events');
  }
  snapshot() {
    const result = Object.fromEntries(collections.filter(k => k !== 'settings').map(k => [k, this.list(k)]));
    // Historical usage records remain on disk, but per-session token accounting is no longer exposed.
    result.sessions = result.sessions.map(({ processToken, usage, ...session }) => session);
    result.settings = this.get('settings', 'main');
    return result;
  }
}
