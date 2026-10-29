// Integração com a API oficial da Luxor (https://docs.luxor.tech/platform/api/introduction).
// Somente leitura: o cliente aceita apenas GET em caminhos de consulta documentados.
// A chave fica no backend (LUXOR_API_KEY) e nunca aparece em logs, erros, API ou navegador.
import type { Provenance } from '../core/types.ts';
import type { AppConfig } from '../config.ts';
import { DisconnectedError, RateLimitedError, type RateLimiter } from '../core/rateLimiter.ts';
import type { PoolAdapter, PoolStats } from './external.ts';
import { SimulatedPool } from './external.ts';

export const LUXOR_DOCS = 'https://docs.luxor.tech/platform/api/introduction';
export const LUXOR_STRATUM_DOCS = 'https://docs.luxor.tech/platform/mining/getting-started';

/** Caminhos de leitura documentados. Qualquer outro é recusado antes de sair do servidor. */
const READ_ONLY_PATHS = [/^\/workspace$/, /^\/pool\/subaccounts$/, /^\/pool\/summary\/[A-Z_]+$/, /^\/pool\/workers\/[A-Z_]+$/, /^\/pool\/revenue\/[A-Z_]+$/, /^\/pool\/transactions\/[A-Z_]+$/];

export class LuxorHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, code: string | undefined, message: string) {
    super(`Luxor HTTP ${status}${code ? ` (${code})` : ''}: ${message}`);
    this.name = 'LuxorHttpError';
    this.status = status;
    this.code = code;
  }
}

export function maskKey(key?: string): string {
  if (!key) return '(ausente)';
  return key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export class LuxorClient {
  private base: string;
  private key?: string;
  private fetchImpl: typeof fetch;
  private limiter?: RateLimiter;

  constructor(opts: { baseUrl: string; apiKey?: string; fetchImpl?: typeof fetch; limiter?: RateLimiter }) {
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.key = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter = opts.limiter;
  }

  get configured(): boolean {
    return !!this.key;
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    if (!READ_ONLY_PATHS.some((r) => r.test(path))) throw new Error(`caminho não permitido (somente leitura): ${path}`);
    if (!this.key) throw new DisconnectedError('LUXOR_API_KEY não configurada');
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    if (this.limiter && !this.limiter.tryTake(url.host)) throw new RateLimitedError(url.host);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { authorization: this.key, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new DisconnectedError(`API Luxor inacessível (${url.host}): ${(e as Error).message}`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const b = (body ?? {}) as { error?: unknown; code?: string; message?: string };
      const nested = typeof b.error === 'object' && b.error !== null ? (b.error as { code?: string; message?: string }) : undefined;
      const msg = nested?.message ?? b.message ?? (typeof b.error === 'string' ? b.error : res.statusText || 'erro');
      throw new LuxorHttpError(res.status, nested?.code ?? b.code, this.scrub(String(msg)));
    }
    if (body === undefined) throw new Error('resposta da Luxor não é JSON');
    return body as T;
  }

  /** Garante que a chave nunca vaze por mensagens de erro vindas do servidor. */
  private scrub(s: string): string {
    return this.key ? s.split(this.key).join('***') : s;
  }
}

// ---------------------------------------------------------------- verificação de esquema (campos documentados)
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface LuxorWorkspace { id: string; name: string; products: string[]; sites: { id: string; name: string; url: string }[] }
export interface LuxorAmount { currency_type: string; revenue_type?: string; revenue: number }
export interface LuxorSummary {
  currency_type: string;
  subaccounts: { id: number; name: string }[];
  hashrate_5m: string; hashrate_1h: string; hashrate_24h: string;
  hashrate_stale_1h: string; hashrate_stale_24h: string;
  efficiency_5m: number; uptime_24h: number; active_miners: number;
  revenue_24h: LuxorAmount[]; revenue_all_time: LuxorAmount[];
  hashprice: { currency_type: string; value: number }[];
  balance: { currency_type: string; revenue: number }[];
}

export function checkWorkspace(d: unknown): string[] {
  const p: string[] = [];
  if (!isObj(d)) return ['workspace: resposta não é objeto'];
  if (typeof d.id !== 'string') p.push('workspace.id ausente');
  if (typeof d.name !== 'string') p.push('workspace.name ausente');
  if (!Array.isArray(d.products)) p.push('workspace.products ausente');
  if (!Array.isArray(d.sites)) p.push('workspace.sites ausente');
  return p;
}

export function checkSummary(d: unknown): string[] {
  const p: string[] = [];
  if (!isObj(d)) return ['summary: resposta não é objeto'];
  for (const k of ['hashrate_5m', 'hashrate_1h', 'hashrate_24h']) if (typeof d[k] !== 'string' && typeof d[k] !== 'number') p.push(`summary.${k} ausente`);
  for (const k of ['active_miners', 'uptime_24h']) if (typeof d[k] !== 'number') p.push(`summary.${k} não numérico`);
  for (const k of ['revenue_24h', 'revenue_all_time', 'balance', 'subaccounts']) if (!Array.isArray(d[k])) p.push(`summary.${k} ausente`);
  return p;
}

export function checkWorkers(d: unknown): string[] {
  const p: string[] = [];
  if (!isObj(d)) return ['workers: resposta não é objeto'];
  if (!Array.isArray(d.workers)) p.push('workers.workers ausente');
  if (typeof d.total_active !== 'number') p.push('workers.total_active não numérico');
  return p;
}

const sumFor = (arr: { currency_type: string; revenue: number }[] | undefined, cur: string) =>
  (arr ?? []).filter((x) => x.currency_type === cur).reduce((a, x) => a + (Number(x.revenue) || 0), 0);

// ---------------------------------------------------------------- estado de validação
export type LuxorAuthState = 'nao_configurada' | 'validada' | 'falhou' | 'inacessivel' | 'resposta_invalida';

export interface LuxorValidation {
  state: LuxorAuthState;
  checkedAt: number;
  httpStatus?: number;
  message: string;
  workspace?: { id: string; name: string; products: string[]; sites: number };
  schemaProblems: string[];
  /** true só quando a autenticação deu 200 e workspace + summary bateram com o esquema documentado. */
  dataVerified: boolean;
}

export interface LuxorSnapshot {
  currency: string;
  activeMiners: number;
  hashrate5m: string;
  hashrate24h: string;
  uptime24h: number;
  efficiency5m?: number;
  balance: number;
  revenue24h: number;
  revenueAllTime: number;
  subaccounts: string[];
}

export interface LuxorPoolStats extends PoolStats {
  fallbackReason?: string;
  luxor?: LuxorSnapshot;
  validation: LuxorValidation;
}

/**
 * Pool Luxor. Só consulta dados depois que GET /workspace responde 200 com o esquema esperado.
 * Sem autenticação válida, ou sem mineradores ativos na conta, as métricas de pool continuam simuladas
 * e o motivo é publicado.
 */
export class LuxorPool implements PoolAdapter {
  provenance: Provenance = 'simulado';
  readonly client: LuxorClient;
  private cfg: AppConfig;
  private sim: SimulatedPool;
  private now: () => number;
  private onValidation: (v: LuxorValidation) => void;
  validation: LuxorValidation;
  private retryAfter = 0;

  constructor(client: LuxorClient, cfg: AppConfig, opts: { now?: () => number; onValidation?: (v: LuxorValidation) => void; initial?: LuxorValidation } = {}) {
    this.client = client;
    this.cfg = cfg;
    this.now = opts.now ?? Date.now;
    this.sim = new SimulatedPool(this.now);
    this.onValidation = opts.onValidation ?? (() => {});
    this.validation = opts.initial ?? {
      state: client.configured ? 'falhou' : 'nao_configurada',
      checkedAt: 0,
      message: client.configured ? 'autenticação ainda não verificada' : 'LUXOR_API_KEY não configurada',
      schemaProblems: [],
      dataVerified: false,
    };
    if (!client.configured) this.validation = { ...this.validation, state: 'nao_configurada', dataVerified: false };
  }

  private record(v: LuxorValidation): void {
    this.validation = v;
    this.onValidation(v);
  }

  private query() {
    return { subaccount_names: this.cfg.luxorSubaccount, site_id: this.cfg.luxorSiteId };
  }

  /** Passo 1: GET /workspace. Nenhuma outra consulta é feita antes de esta ser autorizada. */
  async authenticate(force = false): Promise<LuxorValidation> {
    if (!this.client.configured) {
      this.record({ state: 'nao_configurada', checkedAt: this.now(), message: 'LUXOR_API_KEY não configurada no backend', schemaProblems: [], dataVerified: false });
      return this.validation;
    }
    if (!force && this.validation.state === 'validada' && this.now() - this.validation.checkedAt < 6 * 3_600_000) return this.validation;
    if (!force && this.now() < this.retryAfter) return this.validation;
    try {
      const ws = await this.client.get<LuxorWorkspace>('/workspace');
      const problems = checkWorkspace(ws);
      if (problems.length) {
        this.record({ state: 'resposta_invalida', checkedAt: this.now(), httpStatus: 200, message: 'resposta de /workspace fora do esquema documentado', schemaProblems: problems, dataVerified: false });
      } else {
        this.record({
          state: 'validada',
          checkedAt: this.now(),
          httpStatus: 200,
          message: 'GET /workspace autorizado (HTTP 200)',
          workspace: { id: ws.id, name: ws.name, products: ws.products, sites: ws.sites.length },
          schemaProblems: [],
          dataVerified: false, // só vira true após conferir o summary
        });
      }
    } catch (e) {
      this.retryAfter = this.now() + 15 * 60_000;
      if (e instanceof LuxorHttpError) {
        const why = e.status === 401 ? 'chave inválida ou revogada' : e.status === 403 ? 'chave sem permissão para este recurso' : e.status === 429 ? 'limite de requisições da Luxor' : 'erro da API';
        this.record({ state: 'falhou', checkedAt: this.now(), httpStatus: e.status, message: `${why}: ${e.message}`, schemaProblems: [], dataVerified: false });
      } else if (e instanceof DisconnectedError) {
        this.record({ state: 'inacessivel', checkedAt: this.now(), message: e.message, schemaProblems: [], dataVerified: false });
      } else throw e;
    }
    return this.validation;
  }

  async stats(): Promise<LuxorPoolStats> {
    const v = await this.authenticate();
    if (v.state !== 'validada') return this.fallback(`Luxor não validada: ${v.message}`);
    let summary: LuxorSummary;
    try {
      summary = await this.client.get<LuxorSummary>(`/pool/summary/${this.cfg.luxorCurrency}`, this.query());
    } catch (e) {
      if (e instanceof LuxorHttpError && (e.status === 401 || e.status === 403)) {
        this.record({ ...this.validation, state: 'falhou', httpStatus: e.status, message: e.message, dataVerified: false, checkedAt: this.now() });
      }
      if (e instanceof LuxorHttpError || e instanceof DisconnectedError) return this.fallback(`consulta /pool/summary falhou: ${e.message}`);
      throw e;
    }
    const problems = checkSummary(summary);
    if (problems.length) {
      this.record({ ...this.validation, state: 'resposta_invalida', schemaProblems: problems, dataVerified: false, checkedAt: this.now(), message: 'resposta de /pool/summary fora do esquema documentado' });
      return this.fallback('resposta do summary fora do esquema documentado');
    }
    if (!this.validation.dataVerified) this.record({ ...this.validation, dataVerified: true, message: 'autenticação e dados de /workspace e /pool/summary conferidos' });
    const cur = this.cfg.luxorCurrency;
    const snap: LuxorSnapshot = {
      currency: cur,
      activeMiners: summary.active_miners,
      hashrate5m: String(summary.hashrate_5m),
      hashrate24h: String(summary.hashrate_24h),
      uptime24h: summary.uptime_24h,
      efficiency5m: typeof summary.efficiency_5m === 'number' ? summary.efficiency_5m : undefined,
      balance: sumFor(summary.balance, cur),
      revenue24h: sumFor(summary.revenue_24h, cur),
      revenueAllTime: sumFor(summary.revenue_all_time, cur),
      subaccounts: summary.subaccounts.map((s) => s.name),
    };
    if (!(snap.activeMiners > 0)) {
      return { ...(await this.fallback('Luxor autenticada, mas nenhum minerador ativo na conta (active_miners = 0)')), luxor: snap };
    }
    this.provenance = 'real';
    return { balance: snap.balance, provenance: 'real', source: 'luxor', luxor: snap, validation: this.validation };
  }

  private async fallback(reason: string): Promise<LuxorPoolStats> {
    this.provenance = 'simulado';
    const s = await this.sim.stats();
    return { ...s, provenance: 'simulado', source: 'simulador (fallback Luxor)', fallbackReason: reason, validation: this.validation };
  }
}

// ---------------------------------------------------------------- configuração de minerador (dados da documentação oficial)
const STRATUM_HOSTS: Record<AppConfig['luxorCurrency'], string> = {
  BTC: 'btc.global.luxor.tech',
  LTC_DOGE: 'ltc.global.luxor.tech',
  SC: 'sc.global.luxor.tech',
  ZEC: 'zec.global.luxor.tech',
};

export interface MinerPoolConfig {
  ready: boolean;
  missing: string[];
  url: string;
  worker?: string;
  password: string;
  allowedPoolsEntry: string;
  source: string;
  notes: string[];
}

/** Monta a configuração de pool para o minerador. Não envia nada ao equipamento. */
export function luxorMinerConfig(cfg: AppConfig): MinerPoolConfig {
  const host = STRATUM_HOSTS[cfg.luxorCurrency];
  const url = `stratum+tcp://${host}:700`;
  const missing: string[] = [];
  if (!cfg.luxorSubaccount) missing.push('LUXOR_SUBACCOUNT (subconta criada no painel da Luxor)');
  if (!cfg.luxorWorkerName) missing.push('LUXOR_WORKER_NAME (nome do equipamento, sem símbolos)');
  const badChars = /[^A-Za-z0-9_-]/;
  if (cfg.luxorSubaccount && badChars.test(cfg.luxorSubaccount)) missing.push('LUXOR_SUBACCOUNT contém símbolos (a Luxor recomenda evitar)');
  if (cfg.luxorWorkerName && badChars.test(cfg.luxorWorkerName)) missing.push('LUXOR_WORKER_NAME contém símbolos (a Luxor recomenda evitar)');
  return {
    ready: missing.length === 0,
    missing,
    url,
    worker: cfg.luxorSubaccount && cfg.luxorWorkerName ? `${cfg.luxorSubaccount}.${cfg.luxorWorkerName}` : undefined,
    password: '123',
    allowedPoolsEntry: url,
    source: LUXOR_STRATUM_DOCS,
    notes: [
      'Endereço, porta e formato do worker conforme o guia "Getting Started" da Luxor.',
      'A subconta precisa existir na Luxor antes de configurar o equipamento.',
      'A documentação usa "123" como exemplo de senha e não define outro valor.',
      'Configuração apenas preparada: nada é enviado ao equipamento sem sua ação.',
    ],
  };
}
