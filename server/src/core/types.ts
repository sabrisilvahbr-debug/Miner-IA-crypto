// Contratos centrais do AI CRYPTO MINER — VIRTUAL MINING OFFICE 50.
// Todos os agentes implementam AgentDefinition e trocam dados por Metric e DomainEvent.

export type AgentState =
  | 'operacional'
  | 'ocioso'
  | 'aguardando'
  | 'erro'
  | 'bloqueado'
  | 'desconectado';

export const AGENT_STATES: AgentState[] = [
  'operacional',
  'ocioso',
  'aguardando',
  'erro',
  'bloqueado',
  'desconectado',
];

/** Procedência de todo dado exibido ou armazenado. */
export type Provenance = 'real' | 'estimado' | 'simulado' | 'teste';

/** Maturidade do módulo: só "validado" pode ser chamado de operacional em produção. */
export type Maturity = 'stub' | 'simulado' | 'validado';

export type RunMode = 'continuous' | 'scheduled' | 'event';

export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export type Permission =
  | 'read:market'
  | 'read:miner'
  | 'read:pool'
  | 'read:wallet'
  | 'read:metrics'
  | 'write:metrics'
  | 'read:runtime'
  | 'emit:alert'
  | 'propose:action'
  | 'execute:action'
  | 'control:system'
  | 'call:llm'
  | 'read:secrets'
  | 'write:files'
  | 'notify:external';

export type DepartmentId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface Department {
  id: DepartmentId;
  code: string;
  name: string;
  color: string;
}

export type MetricValue = number | string | boolean | null;

export interface Metric {
  key: string;
  value: MetricValue;
  unit?: string;
  provenance: Provenance;
  source: string;
  ts: number;
  agentId: number;
}

export type MetricInput = Omit<Metric, 'ts' | 'agentId'> & { ts?: number };

export interface DomainEvent {
  id: string;
  type: string;
  ts: number;
  agentId?: number;
  severity: Severity;
  message: string;
  data?: Record<string, unknown>;
  provenance?: Provenance;
}

export type EventInput = Omit<DomainEvent, 'id' | 'ts'> & { ts?: number };

export type ActionKind =
  | 'pause_miner'
  | 'resume_miner'
  | 'restart_miner'
  | 'switch_pool'
  | 'adjust_threads'
  | 'withdraw'
  | 'purchase'
  | 'payment'
  | 'trade';

export type ActionStatus =
  | 'pendente_operador'
  | 'bloqueada'
  | 'aprovada_operador'
  | 'rejeitada'
  | 'executada'
  | 'falhou';

export interface ActionProposal {
  id: string;
  ts: number;
  kind: ActionKind;
  params: Record<string, unknown>;
  reason: string;
  proposedBy: number;
  /** Procedência dos dados que motivaram a proposta. */
  evidence: Provenance;
  status: ActionStatus;
  guardianReasons: string[];
  decidedAt?: number;
  decidedBy?: string;
  result?: string;
}

export type ActionInput = Pick<ActionProposal, 'kind' | 'params' | 'reason' | 'evidence'>;

export interface AlertRecord {
  id: string;
  ts: number;
  severity: Severity;
  code: string;
  message: string;
  agentId?: number;
  acknowledged: boolean;
  count: number;
}

export type ResultStatus = 'ok' | 'skipped' | 'disconnected' | 'blocked';

export interface AgentResult {
  status: ResultStatus;
  summary: string;
  metrics?: MetricInput[];
  events?: EventInput[];
}

export interface Health {
  ok: boolean;
  detail: string;
}

export interface MetricsView {
  get(key: string): Metric | undefined;
  value(key: string): MetricValue | undefined;
  num(key: string): number | undefined;
  all(prefix?: string): Metric[];
  history(key: string, limit?: number): Metric[];
}

export interface AgentContext {
  agentId: number;
  now(): number;
  signal: AbortSignal;
  trigger?: DomainEvent;
  metrics: MetricsView;
  /** Memória em processo do agente entre execuções. */
  memory: Record<string, unknown>;
  config: import('../config.ts').AppConfig;
  services: import('./services.ts').Services;
  log(severity: Severity, message: string, data?: Record<string, unknown>): void;
  emit(event: EventInput): void;
  raiseAlert(code: string, severity: Severity, message: string): void;
  proposeAction(input: ActionInput): ActionProposal;
}

export interface AgentDefinition {
  id: number;
  code: string;
  name: string;
  department: DepartmentId;
  responsibility: string;
  mode: RunMode;
  /** Intervalo para agentes contínuos e agendados. */
  intervalMs?: number;
  /** Tipos de evento que acionam o agente (aceita sufixo ".*"). */
  triggers?: string[];
  permissions: Permission[];
  inputs: string[];
  outputs: string[];
  /** Agentes críticos continuam rodando com o sistema pausado. */
  essential?: boolean;
  maturity: Maturity;
  timeoutMs?: number;
  run(ctx: AgentContext): Promise<AgentResult>;
  health?(ctx: AgentContext): Promise<Health>;
}

export interface AgentRuntimeInfo {
  id: number;
  code: string;
  name: string;
  department: DepartmentId;
  responsibility: string;
  mode: RunMode;
  intervalMs?: number;
  triggers?: string[];
  permissions: Permission[];
  inputs: string[];
  outputs: string[];
  essential: boolean;
  maturity: Maturity;
  state: AgentState;
  running: boolean;
  lastRunAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  lastSummary?: string;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  duplicatesSkipped: number;
  cooldownUntil?: number;
}

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface TaskRecord {
  id: string;
  agentId: number;
  idemKey: string;
  reason: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempts: number;
  error?: string;
}
