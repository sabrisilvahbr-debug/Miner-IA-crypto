// Execução dos agentes: registro central, fila com deduplicação, concorrência limitada,
// tempo limite, novas tentativas com recuo exponencial, estados e registro de execuções.
import { randomUUID } from 'node:crypto';
import type {
  ActionInput,
  ActionProposal,
  AgentContext,
  AgentDefinition,
  AgentResult,
  AgentRuntimeInfo,
  AgentState,
  DomainEvent,
  Metric,
  MetricsView,
  Severity,
  TaskRecord,
} from './types.ts';
import type { AppConfig } from '../config.ts';
import type { Store } from './store.ts';
import type { EventBus } from './eventBus.ts';
import type { RiskGuardian } from './riskGuardian.ts';
import type { Logger } from './logger.ts';
import { PermissionError, scopeServices, type RuntimeView, type Services } from './services.ts';
import { DisconnectedError, RateLimitedError } from './rateLimiter.ts';

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`tempo limite de ${ms} ms excedido`);
    this.name = 'TimeoutError';
  }
}

interface QueuedTask {
  record: TaskRecord;
  trigger?: DomainEvent;
  resolve: (t: TaskRecord) => void;
}

export interface EnqueueResult {
  accepted: boolean;
  duplicate: boolean;
  reason?: string;
  task?: TaskRecord;
  done: Promise<TaskRecord | undefined>;
}

const ALERT_DEDUPE_MS = 10 * 60_000;

export class Runtime implements RuntimeView {
  readonly startedAt: number;
  private defs = new Map<number, AgentDefinition>();
  private infos = new Map<number, AgentRuntimeInfo>();
  private memories = new Map<number, Record<string, unknown>>();
  private queue: QueuedTask[] = [];
  private running = 0;
  private timers: NodeJS.Timeout[] = [];
  private unsubscribers: (() => void)[] = [];
  private duplicates = 0;
  private stopped = true;
  private clients = 0;
  services!: Services;

  readonly config: AppConfig;
  readonly store: Store;
  readonly bus: EventBus;
  readonly guardian: RiskGuardian;
  readonly logger: Logger;
  readonly now: () => number;

  constructor(opts: { config: AppConfig; store: Store; bus: EventBus; guardian: RiskGuardian; logger: Logger; now?: () => number }) {
    this.config = opts.config;
    this.store = opts.store;
    this.bus = opts.bus;
    this.guardian = opts.guardian;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }

  // ------------------------------------------------------------------ registro
  register(defs: AgentDefinition[]): void {
    for (const d of defs) {
      if (this.defs.has(d.id)) throw new Error(`agente duplicado: id ${d.id}`);
      if ([...this.defs.values()].some((x) => x.code === d.code)) throw new Error(`agente duplicado: código ${d.code}`);
      if ((d.mode === 'continuous' || d.mode === 'scheduled') && !d.intervalMs) throw new Error(`agente ${d.code} sem intervalo`);
      if (d.mode === 'event' && !d.triggers?.length) throw new Error(`agente ${d.code} acionado por evento sem gatilhos`);
      this.defs.set(d.id, d);
      const prev = this.store.loadAgentHistory(d.id);
      const info: AgentRuntimeInfo = {
        id: d.id, code: d.code, name: d.name, department: d.department, responsibility: d.responsibility, mode: d.mode,
        intervalMs: d.intervalMs, triggers: d.triggers, permissions: d.permissions, inputs: d.inputs, outputs: d.outputs,
        essential: !!d.essential, maturity: d.maturity, state: 'ocioso', running: false,
        runs: prev?.runs ?? 0, failures: prev?.failures ?? 0, consecutiveFailures: 0, duplicatesSkipped: prev?.duplicatesSkipped ?? 0,
        lastRunAt: prev?.lastRunAt, lastSuccessAt: prev?.lastSuccessAt, lastError: prev?.lastError, lastErrorAt: prev?.lastErrorAt,
        lastSummary: prev?.lastSummary,
      };
      this.infos.set(d.id, info);
      this.memories.set(d.id, {});
      this.store.saveAgent(info);
    }
  }

  // ------------------------------------------------------------------ consultas (RuntimeView)
  agents(): AgentRuntimeInfo[] {
    return [...this.infos.values()].sort((a, b) => a.id - b.id).map((i) => ({ ...i }));
  }
  agent(id: number): AgentRuntimeInfo | undefined {
    const i = this.infos.get(id);
    return i ? { ...i } : undefined;
  }
  definitions(): AgentDefinition[] {
    return [...this.defs.values()].sort((a, b) => a.id - b.id);
  }
  queueStats() {
    return { queued: this.queue.length, running: this.running, maxConcurrency: this.config.maxConcurrency, duplicatesSkipped: this.duplicates };
  }
  stuckTasks(olderThanMs: number): TaskRecord[] {
    const limit = this.now() - olderThanMs;
    return this.store.listTasks({ status: 'running', limit: 100 }).filter((t) => (t.startedAt ?? t.createdAt) < limit);
  }
  failTask(id: string, reason: string): void {
    this.store.updateTask(id, { status: 'failed', finishedAt: this.now(), error: reason });
  }
  setCooldown(agentId: number, untilTs: number): void {
    const i = this.infos.get(agentId);
    if (i) i.cooldownUntil = untilTs;
  }
  clientCount(): number {
    return this.clients;
  }
  setClientCount(n: number): void {
    this.clients = n;
  }

  collectiveSummary() {
    const agents = this.agents();
    const byState: Record<AgentState, number> = { operacional: 0, ocioso: 0, aguardando: 0, erro: 0, bloqueado: 0, desconectado: 0 };
    const byDepartment: Record<number, Record<AgentState, number>> = {};
    const byMaturity: Record<string, number> = {};
    for (const a of agents) {
      byState[a.state]++;
      byDepartment[a.department] ??= { operacional: 0, ocioso: 0, aguardando: 0, erro: 0, bloqueado: 0, desconectado: 0 };
      byDepartment[a.department][a.state]++;
      byMaturity[a.maturity] = (byMaturity[a.maturity] ?? 0) + 1;
    }
    return { total: agents.length, byState, byDepartment, byMaturity, queue: this.queueStats() };
  }

  // ------------------------------------------------------------------ ciclo de vida
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const orphans = this.store.failOrphanTasks(this.now());
    if (orphans) this.logger.log('warn', 'tarefas órfãs marcadas como falhas', { orphans });
    let stagger = 0;
    for (const d of this.definitions()) {
      if (d.mode === 'continuous' || d.mode === 'scheduled') {
        const first = setTimeout(() => this.enqueue(d.id, 'inicialização'), 200 + stagger * 60);
        stagger++;
        this.timers.push(first);
        this.timers.push(setInterval(() => this.enqueue(d.id, d.mode === 'continuous' ? 'ciclo contínuo' : 'agendamento'), d.intervalMs));
      }
      for (const pattern of d.triggers ?? []) {
        this.unsubscribers.push(this.bus.subscribe(pattern, (e) => {
          if (e.agentId === d.id) return; // um agente não aciona a si mesmo
          this.enqueue(d.id, `evento ${e.type}`, e);
        }));
      }
    }
    this.bus.publish({ type: 'system.started', severity: 'info', message: `Runtime iniciado com ${this.defs.size} agentes` });
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  /** Ativa os gatilhos de evento sem iniciar os temporizadores (usado em testes). */
  wireTriggersOnly(): void {
    for (const d of this.definitions()) {
      for (const pattern of d.triggers ?? []) {
        this.unsubscribers.push(this.bus.subscribe(pattern, (e) => {
          if (e.agentId !== d.id) this.enqueue(d.id, `evento ${e.type}`, e);
        }));
      }
    }
  }

  // ------------------------------------------------------------------ fila
  enqueue(agentId: number, reason: string, trigger?: DomainEvent, idemKey?: string): EnqueueResult {
    const def = this.defs.get(agentId);
    if (!def) return { accepted: false, duplicate: false, reason: 'agente inexistente', done: Promise.resolve(undefined) };
    const dedupe = trigger?.data && typeof trigger.data.dedupeKey === 'string' ? trigger.data.dedupeKey : trigger?.type ?? 'ciclo';
    const key = idemKey ?? `${agentId}:${dedupe}`;
    const record: TaskRecord = { id: randomUUID(), agentId, idemKey: key, reason, status: 'queued', createdAt: this.now(), attempts: 0 };
    if (!this.store.insertTask(record)) {
      this.duplicates++;
      const info = this.infos.get(agentId)!;
      info.duplicatesSkipped++;
      return { accepted: false, duplicate: true, reason: 'tarefa equivalente já está na fila ou em execução', done: Promise.resolve(undefined) };
    }
    let resolve!: (t: TaskRecord) => void;
    const done = new Promise<TaskRecord>((r) => (resolve = r));
    this.queue.push({ record, trigger, resolve });
    const info = this.infos.get(agentId)!;
    if (!info.running) this.setState(info, 'aguardando');
    queueMicrotask(() => this.pump());
    return { accepted: true, duplicate: false, task: record, done };
  }

  /** Executa um agente e aguarda o término (útil para API manual e testes). */
  async runOnce(agentId: number, trigger?: DomainEvent): Promise<TaskRecord | undefined> {
    const r = this.enqueue(agentId, 'execução manual', trigger, `${agentId}:manual:${trigger?.id ?? 'x'}`);
    return r.done;
  }

  private pump(): void {
    while (this.running < this.config.maxConcurrency && this.queue.length) {
      const next = this.queue.shift()!;
      this.running++;
      this.execute(next)
        .catch((e) => this.logger.log('error', 'falha inesperada no executor', { error: String(e) }))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  // ------------------------------------------------------------------ execução
  private async execute(q: QueuedTask): Promise<void> {
    const def = this.defs.get(q.record.agentId)!;
    const info = this.infos.get(def.id)!;
    const task = q.record;
    const finish = (status: TaskRecord['status'], error?: string) => {
      task.status = status;
      task.finishedAt = this.now();
      task.error = error;
      this.store.updateTask(task.id, { status, finishedAt: task.finishedAt, attempts: task.attempts, error });
      this.store.saveAgent(info);
      q.resolve({ ...task });
    };

    if (this.guardian.pauseState().paused && !def.essential) {
      this.setState(info, 'bloqueado', 'sistema pausado pelo Guardião de Risco');
      return finish('skipped', 'sistema pausado');
    }
    if (info.cooldownUntil && info.cooldownUntil > this.now()) {
      this.setState(info, 'bloqueado', 'em período de espera após falhas consecutivas');
      return finish('skipped', 'em período de espera');
    }

    task.startedAt = this.now();
    this.store.updateTask(task.id, { status: 'running', startedAt: task.startedAt });
    info.running = true;
    this.setState(info, 'operacional');

    const maxAttempts = Math.max(1, this.config.maxRetries + 1);
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      task.attempts = attempt;
      const started = this.now();
      try {
        const result = await this.runWithTimeout(def, q.trigger);
        this.applyResult(def, result);
        this.store.insertExecution({ taskId: task.id, agentId: def.id, attempt, startedAt: started, finishedAt: this.now(), ok: true, status: result.status, summary: result.summary });
        info.running = false;
        info.runs++;
        info.lastRunAt = this.now();
        info.lastSummary = result.summary;
        if (result.status === 'ok') {
          info.lastSuccessAt = this.now();
          info.consecutiveFailures = 0;
          this.setState(info, 'operacional');
        } else if (result.status === 'skipped') {
          info.consecutiveFailures = 0;
          this.setState(info, 'ocioso');
        } else if (result.status === 'disconnected') {
          this.setState(info, 'desconectado', result.summary);
        } else {
          this.setState(info, 'bloqueado', result.summary);
        }
        return finish(result.status === 'skipped' ? 'skipped' : 'done');
      } catch (e) {
        lastErr = e as Error;
        this.store.insertExecution({ taskId: task.id, agentId: def.id, attempt, startedAt: started, finishedAt: this.now(), ok: false, status: 'error', error: lastErr.message });
        if (e instanceof DisconnectedError) {
          info.running = false;
          info.runs++;
          info.lastRunAt = this.now();
          info.lastSummary = lastErr.message;
          this.setState(info, 'desconectado', lastErr.message);
          return finish('done', lastErr.message);
        }
        if (e instanceof RateLimitedError) {
          info.running = false;
          this.setState(info, 'aguardando', lastErr.message);
          return finish('skipped', lastErr.message);
        }
        if (e instanceof PermissionError) break; // erro de configuração: não adianta repetir
        if (attempt < maxAttempts) await sleep(this.config.retryBaseMs * 2 ** (attempt - 1));
      }
    }
    info.running = false;
    info.runs++;
    info.failures++;
    info.consecutiveFailures++;
    info.lastRunAt = this.now();
    info.lastError = lastErr?.message ?? 'erro desconhecido';
    info.lastErrorAt = this.now();
    this.setState(info, 'erro', info.lastError);
    this.bus.publish({
      type: 'agent.error',
      agentId: def.id,
      severity: 'error',
      message: `${def.code} ${def.name}: ${info.lastError}`,
      data: { consecutiveFailures: info.consecutiveFailures, dedupeKey: `agent-error-${def.id}` },
    });
    finish('failed', info.lastError);
  }

  private runWithTimeout(def: AgentDefinition, trigger?: DomainEvent): Promise<AgentResult> {
    const ms = def.timeoutMs ?? this.config.taskTimeoutMs;
    const ac = new AbortController();
    const ctx = this.buildContext(def, ac.signal, trigger);
    return new Promise<AgentResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        ac.abort();
        reject(new TimeoutError(ms));
      }, ms);
      def.run(ctx).then(
        (r) => { clearTimeout(timer); resolve(r); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  private applyResult(def: AgentDefinition, r: AgentResult): void {
    if (r.metrics?.length) {
      if (!def.permissions.includes('write:metrics')) throw new PermissionError(def.code, 'write:metrics');
      for (const m of r.metrics) {
        if (!m.provenance) throw new Error(`métrica ${m.key} sem procedência`);
        const metric: Metric = { ...m, ts: m.ts ?? this.now(), agentId: def.id };
        this.store.putMetric(metric);
        this.bus.publish({ type: `metric.${m.key}`, agentId: def.id, severity: 'debug', message: m.key, data: { value: m.value, provenance: m.provenance } }, false);
      }
    }
    for (const e of r.events ?? []) this.bus.publish({ ...e, agentId: e.agentId ?? def.id });
  }

  private setState(info: AgentRuntimeInfo, state: AgentState, detail?: string): void {
    const changed = info.state !== state;
    info.state = state;
    if (changed) {
      this.bus.publish({ type: 'agent.state', agentId: info.id, severity: 'debug', message: `${info.code} → ${state}`, data: { state, detail, running: info.running } }, false);
    }
  }

  // ------------------------------------------------------------------ contexto do agente
  metricsView(): MetricsView {
    const store = this.store;
    return {
      get: (k) => store.latestMetric(k),
      value: (k) => store.latestMetric(k)?.value,
      num: (k) => {
        const v = store.latestMetric(k)?.value;
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      },
      all: (prefix) => store.latestMetrics(prefix ?? ''),
      history: (k, limit) => store.metricHistory(k, limit ?? 100),
    };
  }

  buildContext(def: AgentDefinition, signal: AbortSignal, trigger?: DomainEvent): AgentContext {
    const require = (p: AgentDefinition['permissions'][number]) => {
      if (!def.permissions.includes(p)) throw new PermissionError(def.code, p);
    };
    return {
      agentId: def.id,
      now: this.now,
      signal,
      trigger,
      metrics: this.metricsView(),
      memory: this.memories.get(def.id)!,
      config: this.config,
      services: scopeServices(this.services, def),
      log: (severity, message, data) => this.logger.log(severity, message, { agent: def.code, ...data }),
      emit: (e) => { this.bus.publish({ ...e, agentId: e.agentId ?? def.id }); },
      raiseAlert: (code, severity, message) => {
        require('emit:alert');
        this.raiseAlert(code, severity, message, def.id);
      },
      proposeAction: (input) => {
        require('propose:action');
        return this.proposeAction(input, def.id);
      },
    };
  }

  raiseAlert(code: string, severity: Severity, message: string, agentId?: number): void {
    const { alert, isNew } = this.store.upsertAlert({ id: randomUUID(), ts: this.now(), severity, code, message, agentId }, ALERT_DEDUPE_MS);
    this.bus.publish(
      { type: isNew ? 'alert.raised' : 'alert.repeated', agentId, severity, message, data: { alertId: alert.id, code, count: alert.count, dedupeKey: `alert-${code}` } },
      isNew,
    );
  }

  // ------------------------------------------------------------------ ações
  proposeAction(input: ActionInput, proposedBy: number): ActionProposal {
    const ev = this.guardian.evaluate(input);
    const a: ActionProposal = {
      id: randomUUID(),
      ts: this.now(),
      ...input,
      proposedBy,
      status: ev.allowed ? 'pendente_operador' : 'bloqueada',
      guardianReasons: ev.reasons,
    };
    this.store.saveAction(a);
    this.bus.publish({
      type: ev.allowed ? 'action.proposed' : 'action.blocked',
      agentId: proposedBy,
      severity: ev.allowed ? 'info' : 'warn',
      message: ev.allowed ? `Ação proposta aguardando operador: ${a.kind}` : `Ação bloqueada pelo Guardião: ${a.kind} (${ev.reasons.join('; ')})`,
      data: { actionId: a.id, kind: a.kind, reasons: ev.reasons, dedupeKey: `action-${a.id}` },
    });
    return a;
  }

  decideAction(id: string, decision: 'approve' | 'reject', by: string): { ok: boolean; action?: ActionProposal; reason?: string } {
    const a = this.store.getAction(id);
    if (!a) return { ok: false, reason: 'ação inexistente' };
    if (a.status !== 'pendente_operador') return { ok: false, action: a, reason: `ação em estado ${a.status}` };
    a.decidedAt = this.now();
    a.decidedBy = by;
    if (decision === 'reject') {
      a.status = 'rejeitada';
      this.store.saveAction(a);
      this.bus.publish({ type: 'action.rejected', severity: 'info', message: `Operador rejeitou ${a.kind}`, data: { actionId: a.id, dedupeKey: `action-${a.id}` } });
      return { ok: true, action: a };
    }
    const ev = this.guardian.evaluate(a);
    if (!ev.allowed) {
      a.status = 'bloqueada';
      a.guardianReasons = ev.reasons;
      this.store.saveAction(a);
      this.bus.publish({ type: 'action.blocked', severity: 'warn', message: `Guardião bloqueou ${a.kind} na aprovação`, data: { actionId: a.id, reasons: ev.reasons, dedupeKey: `action-${a.id}` } });
      return { ok: false, action: a, reason: ev.reasons.join('; ') };
    }
    a.status = 'aprovada_operador';
    this.store.saveAction(a);
    this.bus.publish({ type: 'action.approved', severity: 'info', message: `Operador aprovou ${a.kind}`, data: { actionId: a.id, dedupeKey: `action-${a.id}` } });
    return { ok: true, action: a };
  }

  // ------------------------------------------------------------------ controle do sistema
  pauseSystem(reason: string, by: string) {
    const s = this.guardian.pause(reason, by);
    this.bus.publish({ type: 'system.paused', severity: 'warn', message: `Sistema pausado por ${by}: ${reason}`, data: { reason, by } });
    for (const info of this.infos.values()) {
      if (!this.defs.get(info.id)!.essential && !info.running) this.setState(info, 'bloqueado', 'sistema pausado');
    }
    return s;
  }

  resumeSystem(by: string) {
    const r = this.guardian.resume(by);
    if (r.ok) {
      this.bus.publish({ type: 'system.resumed', severity: 'info', message: `Sistema retomado por ${by}`, data: { by } });
      for (const info of this.infos.values()) if (info.state === 'bloqueado') this.setState(info, 'ocioso');
    }
    return r;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
