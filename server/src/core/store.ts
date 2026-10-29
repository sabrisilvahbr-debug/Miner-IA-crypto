// Persistência em SQLite (módulo nativo node:sqlite, sem dependências externas).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ActionProposal,
  AgentRuntimeInfo,
  AlertRecord,
  DomainEvent,
  Metric,
  Severity,
  TaskRecord,
} from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, department INTEGER NOT NULL,
  mode TEXT NOT NULL, maturity TEXT NOT NULL, state TEXT NOT NULL,
  last_run_at INTEGER, last_success_at INTEGER, last_error TEXT, last_error_at INTEGER, last_summary TEXT,
  runs INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, duplicates_skipped INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, idem_key TEXT NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_active_key ON tasks(idem_key) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS tasks_agent ON tasks(agent_id, created_at);
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent_id INTEGER NOT NULL, attempt INTEGER NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, ok INTEGER NOT NULL, status TEXT NOT NULL,
  summary TEXT, error TEXT, duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS executions_agent ON executions(agent_id, started_at);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, agent_id INTEGER, severity TEXT NOT NULL,
  message TEXT NOT NULL, data_json TEXT, provenance TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, ts INTEGER NOT NULL, value_json TEXT NOT NULL,
  unit TEXT, provenance TEXT NOT NULL, source TEXT NOT NULL, agent_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS metrics_key_ts ON metrics(key, ts);
CREATE TABLE IF NOT EXISTS metrics_latest (
  key TEXT PRIMARY KEY, ts INTEGER NOT NULL, value_json TEXT NOT NULL, unit TEXT,
  provenance TEXT NOT NULL, source TEXT NOT NULL, agent_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, severity TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL,
  agent_id INTEGER, acknowledged INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS alerts_code ON alerts(code, ts);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, params_json TEXT NOT NULL, reason TEXT NOT NULL,
  proposed_by INTEGER NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL, guardian_reasons_json TEXT NOT NULL,
  decided_at INTEGER, decided_by TEXT, result TEXT
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent_id INTEGER NOT NULL, purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, body_json TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(v: unknown, d: T): T => {
  if (typeof v !== 'string') return d;
  try {
    return JSON.parse(v) as T;
  } catch {
    return d;
  }
};
const n = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
const s = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------- agentes ----------
  saveAgent(a: AgentRuntimeInfo): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, code, name, department, mode, maturity, state, last_run_at, last_success_at, last_error,
          last_error_at, last_summary, runs, failures, consecutive_failures, duplicates_skipped)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name, department=excluded.department,
          mode=excluded.mode, maturity=excluded.maturity, state=excluded.state, last_run_at=excluded.last_run_at,
          last_success_at=excluded.last_success_at, last_error=excluded.last_error, last_error_at=excluded.last_error_at,
          last_summary=excluded.last_summary, runs=excluded.runs, failures=excluded.failures,
          consecutive_failures=excluded.consecutive_failures, duplicates_skipped=excluded.duplicates_skipped`,
      )
      .run(
        a.id, a.code, a.name, a.department, a.mode, a.maturity, a.state, a.lastRunAt ?? null, a.lastSuccessAt ?? null,
        a.lastError ?? null, a.lastErrorAt ?? null, a.lastSummary ?? null, a.runs, a.failures, a.consecutiveFailures,
        a.duplicatesSkipped,
      );
  }

  loadAgentHistory(id: number): Partial<AgentRuntimeInfo> | undefined {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    if (!r) return undefined;
    return {
      lastRunAt: n(r.last_run_at),
      lastSuccessAt: n(r.last_success_at),
      lastError: s(r.last_error),
      lastErrorAt: n(r.last_error_at),
      lastSummary: s(r.last_summary),
      runs: Number(r.runs),
      failures: Number(r.failures),
      duplicatesSkipped: Number(r.duplicates_skipped),
    };
  }

  // ---------- tarefas ----------
  /** Insere a tarefa. Retorna false se já existe tarefa ativa com a mesma chave (deduplicação). */
  insertTask(t: TaskRecord): boolean {
    try {
      this.db
        .prepare('INSERT INTO tasks (id, agent_id, idem_key, reason, status, created_at, attempts) VALUES (?,?,?,?,?,?,0)')
        .run(t.id, t.agentId, t.idemKey, t.reason, t.status, t.createdAt);
      return true;
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) return false;
      throw e;
    }
  }

  updateTask(id: string, patch: Partial<TaskRecord>): void {
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const map: Record<string, string> = {
      status: 'status', startedAt: 'started_at', finishedAt: 'finished_at', attempts: 'attempts', error: 'error',
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        cols.push(`${col} = ?`);
        vals.push((patch as Record<string, string | number | undefined>)[k] ?? null);
      }
    }
    if (!cols.length) return;
    this.db.prepare(`UPDATE tasks SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  /** Recupera tarefas abandonadas por um desligamento anterior. */
  failOrphanTasks(now: number): number {
    const r = this.db
      .prepare(`UPDATE tasks SET status='failed', finished_at=?, error='interrompida por reinício' WHERE status IN ('queued','running')`)
      .run(now);
    return Number(r.changes);
  }

  listTasks(opts: { agentId?: number; status?: string; limit?: number } = {}): TaskRecord[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (opts.agentId !== undefined) { where.push('agent_id = ?'); vals.push(opts.agentId); }
    if (opts.status) { where.push('status = ?'); vals.push(opts.status); }
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...vals, opts.limit ?? 50) as Row[];
    return rows.map((r) => ({
      id: String(r.id), agentId: Number(r.agent_id), idemKey: String(r.idem_key), reason: String(r.reason),
      status: r.status as TaskRecord['status'], createdAt: Number(r.created_at), startedAt: n(r.started_at),
      finishedAt: n(r.finished_at), attempts: Number(r.attempts), error: s(r.error),
    }));
  }

  countTasks(status: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) c FROM tasks WHERE status = ?').get(status) as Row).c);
  }

  // ---------- execuções ----------
  insertExecution(e: {
    taskId: string; agentId: number; attempt: number; startedAt: number; finishedAt: number; ok: boolean;
    status: string; summary?: string; error?: string;
  }): void {
    this.db
      .prepare(`INSERT INTO executions (task_id, agent_id, attempt, started_at, finished_at, ok, status, summary, error, duration_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(e.taskId, e.agentId, e.attempt, e.startedAt, e.finishedAt, e.ok ? 1 : 0, e.status, e.summary ?? null,
        e.error ?? null, e.finishedAt - e.startedAt);
  }

  listExecutions(agentId: number, limit = 20): Row[] {
    return this.db
      .prepare('SELECT * FROM executions WHERE agent_id = ? ORDER BY id DESC LIMIT ?')
      .all(agentId, limit) as Row[];
  }

  // ---------- eventos ----------
  insertEvent(e: DomainEvent): void {
    this.db
      .prepare('INSERT INTO events (id, ts, type, agent_id, severity, message, data_json, provenance) VALUES (?,?,?,?,?,?,?,?)')
      .run(e.id, e.ts, e.type, e.agentId ?? null, e.severity, e.message, e.data ? j(e.data) : null, e.provenance ?? null);
  }

  listEvents(opts: { limit?: number; agentId?: number; severity?: Severity[]; type?: string; since?: number } = {}): DomainEvent[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (opts.agentId !== undefined) { where.push('agent_id = ?'); vals.push(opts.agentId); }
    if (opts.severity?.length) { where.push(`severity IN (${opts.severity.map(() => '?').join(',')})`); vals.push(...opts.severity); }
    if (opts.type) { where.push('type LIKE ?'); vals.push(opts.type.replace('*', '%')); }
    if (opts.since) { where.push('ts >= ?'); vals.push(opts.since); }
    const rows = this.db
      .prepare(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, rowid DESC LIMIT ?`)
      .all(...vals, Math.min(opts.limit ?? 100, 1000)) as Row[];
    return rows.map((r) => ({
      id: String(r.id), ts: Number(r.ts), type: String(r.type), agentId: n(r.agent_id), severity: r.severity as Severity,
      message: String(r.message), data: pj(r.data_json, undefined), provenance: (s(r.provenance) as DomainEvent['provenance']),
    }));
  }

  countEventsSince(ts: number): number {
    return Number((this.db.prepare('SELECT COUNT(*) c FROM events WHERE ts >= ?').get(ts) as Row).c);
  }

  // ---------- métricas ----------
  putMetric(m: Metric): void {
    const v = j(m.value);
    this.db
      .prepare('INSERT INTO metrics (key, ts, value_json, unit, provenance, source, agent_id) VALUES (?,?,?,?,?,?,?)')
      .run(m.key, m.ts, v, m.unit ?? null, m.provenance, m.source, m.agentId);
    this.db
      .prepare(`INSERT INTO metrics_latest (key, ts, value_json, unit, provenance, source, agent_id) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET ts=excluded.ts, value_json=excluded.value_json, unit=excluded.unit,
        provenance=excluded.provenance, source=excluded.source, agent_id=excluded.agent_id`)
      .run(m.key, m.ts, v, m.unit ?? null, m.provenance, m.source, m.agentId);
  }

  private rowToMetric(r: Row): Metric {
    return {
      key: String(r.key), ts: Number(r.ts), value: pj(r.value_json, null), unit: s(r.unit),
      provenance: r.provenance as Metric['provenance'], source: String(r.source), agentId: Number(r.agent_id),
    };
  }

  latestMetrics(prefix = ''): Metric[] {
    return (this.db.prepare('SELECT * FROM metrics_latest WHERE key LIKE ? ORDER BY key').all(prefix + '%') as Row[]).map((r) =>
      this.rowToMetric(r),
    );
  }

  latestMetric(key: string): Metric | undefined {
    const r = this.db.prepare('SELECT * FROM metrics_latest WHERE key = ?').get(key) as Row | undefined;
    return r ? this.rowToMetric(r) : undefined;
  }

  metricHistory(key: string, limit = 100, since?: number): Metric[] {
    const rows = this.db
      .prepare(`SELECT * FROM metrics WHERE key = ? ${since ? 'AND ts >= ?' : ''} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(...(since ? [key, since, limit] : [key, limit])) as Row[];
    return rows.map((r) => this.rowToMetric(r)).reverse();
  }

  /** Último valor registrado até o instante informado. */
  metricAt(key: string, ts: number): Metric | undefined {
    const r = this.db.prepare('SELECT * FROM metrics WHERE key = ? AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1').get(key, ts) as Row | undefined;
    return r ? this.rowToMetric(r) : undefined;
  }

  // ---------- alertas ----------
  /** Agrupa alertas com o mesmo código dentro da janela de deduplicação. */
  upsertAlert(a: Omit<AlertRecord, 'acknowledged' | 'count'>, dedupeWindowMs: number): { alert: AlertRecord; isNew: boolean } {
    const existing = this.db
      .prepare('SELECT * FROM alerts WHERE code = ? AND acknowledged = 0 AND ts >= ? ORDER BY ts DESC LIMIT 1')
      .get(a.code, a.ts - dedupeWindowMs) as Row | undefined;
    if (existing) {
      this.db.prepare('UPDATE alerts SET count = count + 1, ts = ?, message = ?, severity = ? WHERE id = ?')
        .run(a.ts, a.message, a.severity, String(existing.id));
      return { alert: this.getAlert(String(existing.id))!, isNew: false };
    }
    this.db.prepare('INSERT INTO alerts (id, ts, severity, code, message, agent_id) VALUES (?,?,?,?,?,?)')
      .run(a.id, a.ts, a.severity, a.code, a.message, a.agentId ?? null);
    return { alert: this.getAlert(a.id)!, isNew: true };
  }

  getAlert(id: string): AlertRecord | undefined {
    const r = this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToAlert(r) : undefined;
  }

  private rowToAlert(r: Row): AlertRecord {
    return {
      id: String(r.id), ts: Number(r.ts), severity: r.severity as Severity, code: String(r.code), message: String(r.message),
      agentId: n(r.agent_id), acknowledged: Boolean(r.acknowledged), count: Number(r.count),
    };
  }

  listAlerts(opts: { openOnly?: boolean; limit?: number } = {}): AlertRecord[] {
    return (this.db
      .prepare(`SELECT * FROM alerts ${opts.openOnly ? 'WHERE acknowledged = 0' : ''} ORDER BY ts DESC LIMIT ?`)
      .all(opts.limit ?? 100) as Row[]).map((r) => this.rowToAlert(r));
  }

  ackAlert(id: string): boolean {
    return Number(this.db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id).changes) > 0;
  }

  // ---------- ações ----------
  saveAction(a: ActionProposal): void {
    this.db
      .prepare(`INSERT INTO actions (id, ts, kind, params_json, reason, proposed_by, evidence, status, guardian_reasons_json,
        decided_at, decided_by, result) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, guardian_reasons_json=excluded.guardian_reasons_json,
        decided_at=excluded.decided_at, decided_by=excluded.decided_by, result=excluded.result`)
      .run(a.id, a.ts, a.kind, j(a.params), a.reason, a.proposedBy, a.evidence, a.status, j(a.guardianReasons),
        a.decidedAt ?? null, a.decidedBy ?? null, a.result ?? null);
  }

  private rowToAction(r: Row): ActionProposal {
    return {
      id: String(r.id), ts: Number(r.ts), kind: r.kind as ActionProposal['kind'], params: pj(r.params_json, {}),
      reason: String(r.reason), proposedBy: Number(r.proposed_by), evidence: r.evidence as ActionProposal['evidence'],
      status: r.status as ActionProposal['status'], guardianReasons: pj(r.guardian_reasons_json, []),
      decidedAt: n(r.decided_at), decidedBy: s(r.decided_by), result: s(r.result),
    };
  }

  getAction(id: string): ActionProposal | undefined {
    const r = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToAction(r) : undefined;
  }

  listActions(opts: { status?: string; limit?: number } = {}): ActionProposal[] {
    return (this.db
      .prepare(`SELECT * FROM actions ${opts.status ? 'WHERE status = ?' : ''} ORDER BY ts DESC LIMIT ?`)
      .all(...(opts.status ? [opts.status, opts.limit ?? 100] : [opts.limit ?? 100])) as Row[]).map((r) => this.rowToAction(r));
  }

  countActionsSince(since: number, kind?: string, statuses?: string[]): number {
    const where = ['ts >= ?'];
    const vals: (string | number)[] = [since];
    if (kind) { where.push('kind = ?'); vals.push(kind); }
    if (statuses?.length) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); vals.push(...statuses); }
    return Number((this.db.prepare(`SELECT COUNT(*) c FROM actions WHERE ${where.join(' AND ')}`).get(...vals) as Row).c);
  }

  // ---------- chave-valor ----------
  getKV<T>(key: string, d: T): T {
    const r = this.db.prepare('SELECT value_json FROM kv WHERE key = ?').get(key) as Row | undefined;
    return r ? pj(r.value_json, d) : d;
  }

  setKV(key: string, value: unknown, now = Date.now()): void {
    this.db.prepare(`INSERT INTO kv (key, value_json, updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`).run(key, j(value), now);
  }

  // ---------- uso de LLM ----------
  insertLlmUsage(u: { ts: number; agentId: number; purpose: string; inputTokens: number; outputTokens: number; ok: boolean; error?: string }): void {
    this.db.prepare('INSERT INTO llm_usage (ts, agent_id, purpose, input_tokens, output_tokens, ok, error) VALUES (?,?,?,?,?,?,?)')
      .run(u.ts, u.agentId, u.purpose, u.inputTokens, u.outputTokens, u.ok ? 1 : 0, u.error ?? null);
  }

  llmUsageSince(since: number): { calls: number; tokens: number } {
    const r = this.db
      .prepare('SELECT COUNT(*) c, COALESCE(SUM(input_tokens + output_tokens), 0) t FROM llm_usage WHERE ts >= ?')
      .get(since) as Row;
    return { calls: Number(r.c), tokens: Number(r.t) };
  }

  // ---------- auditoria ----------
  lastAudit(): { seq: number; hash: string } | undefined {
    const r = this.db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get() as Row | undefined;
    return r ? { seq: Number(r.seq), hash: String(r.hash) } : undefined;
  }

  insertAudit(a: { ts: number; type: string; payloadJson: string; prevHash: string; hash: string }): void {
    this.db.prepare('INSERT INTO audit (ts, type, payload_json, prev_hash, hash) VALUES (?,?,?,?,?)')
      .run(a.ts, a.type, a.payloadJson, a.prevHash, a.hash);
  }

  listAudit(limit = 10000): { seq: number; ts: number; type: string; payloadJson: string; prevHash: string; hash: string }[] {
    return (this.db.prepare('SELECT * FROM audit ORDER BY seq ASC LIMIT ?').all(limit) as Row[]).map((r) => ({
      seq: Number(r.seq), ts: Number(r.ts), type: String(r.type), payloadJson: String(r.payload_json),
      prevHash: String(r.prev_hash), hash: String(r.hash),
    }));
  }

  // ---------- relatórios ----------
  insertReport(kind: string, body: unknown, ts = Date.now()): void {
    this.db.prepare('INSERT INTO reports (ts, kind, body_json) VALUES (?,?,?)').run(ts, kind, j(body));
  }

  latestReport(kind: string): { ts: number; body: unknown } | undefined {
    const r = this.db.prepare('SELECT * FROM reports WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind) as Row | undefined;
    return r ? { ts: Number(r.ts), body: pj(r.body_json, null) } : undefined;
  }

  // ---------- retenção e backup ----------
  purgeOlderThan(ts: number): { events: number; metrics: number; tasks: number; executions: number } {
    return {
      events: Number(this.db.prepare('DELETE FROM events WHERE ts < ?').run(ts).changes),
      metrics: Number(this.db.prepare('DELETE FROM metrics WHERE ts < ?').run(ts).changes),
      tasks: Number(this.db.prepare(`DELETE FROM tasks WHERE created_at < ? AND status NOT IN ('queued','running')`).run(ts).changes),
      executions: Number(this.db.prepare('DELETE FROM executions WHERE started_at < ?').run(ts).changes),
    };
  }

  backupTo(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(path);
  }
}
