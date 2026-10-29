// Estado da mineração: máquina de estados explícita + indicadores independentes.
// "MINERANDO" exige evidência verificável: processo ativo E hashrate medido pelo próprio minerador.
// GPU em uso, worker conectado, shares, saldo e pagamentos são indicadores SEPARADOS e nunca se misturam.

export type MiningState =
  | 'DESATIVADA'
  | 'PRONTA PARA TESTE'
  | 'TESTE AUTORIZADO'
  | 'INICIANDO'
  | 'MINERANDO'
  | 'ERRO'
  | 'PARADA'
  | 'DADOS INDISPONÍVEIS';

export const ALLOWED_TRANSITIONS: Record<MiningState, MiningState[]> = {
  DESATIVADA: ['PRONTA PARA TESTE', 'DADOS INDISPONÍVEIS'],
  'DADOS INDISPONÍVEIS': ['DESATIVADA', 'PRONTA PARA TESTE'],
  'PRONTA PARA TESTE': ['TESTE AUTORIZADO', 'DESATIVADA', 'DADOS INDISPONÍVEIS'],
  'TESTE AUTORIZADO': ['INICIANDO', 'DESATIVADA', 'PARADA'],
  INICIANDO: ['MINERANDO', 'ERRO', 'PARADA'],
  MINERANDO: ['PARADA', 'ERRO', 'DADOS INDISPONÍVEIS'],
  ERRO: ['PARADA', 'DESATIVADA'],
  PARADA: ['DESATIVADA', 'PRONTA PARA TESTE'],
};

export interface Transition {
  from: MiningState;
  to: MiningState;
  at: number;
  origem: string; // quem pediu: operador, supervisor, agente N, inicialização...
  motivo: string;
}

export interface MiningEvidence {
  processAlive: boolean;
  minerHashrate?: { value: number; unit: string; at: number }; // reportado pelo minerador
}

export class TransitionError extends Error {}

export class MiningStateMachine {
  private current: MiningState = 'DESATIVADA';
  private since: number;
  private log: Transition[] = [];
  private now: () => number;
  private onChange: (t: Transition) => void;

  /** Sempre começa DESATIVADA: um teste nunca é retomado sozinho depois de reiniciar o Windows ou o servidor. */
  constructor(opts: { now?: () => number; onChange?: (t: Transition) => void; previous?: Transition[] } = {}) {
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange ?? (() => {});
    this.since = this.now();
    if (opts.previous?.length) this.log = opts.previous.slice(-100);
    this.record({ from: this.current, to: 'DESATIVADA', at: this.since, origem: 'inicialização', motivo: 'o sistema sempre inicia com a mineração desativada' });
  }

  get state(): MiningState {
    return this.current;
  }

  history(): Transition[] {
    return [...this.log];
  }

  private record(t: Transition): void {
    this.log.push(t);
    if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
    this.onChange(t);
  }

  transition(to: MiningState, origem: string, motivo: string, evidence?: MiningEvidence): Transition {
    if (!motivo.trim()) throw new TransitionError('toda transição precisa de motivo');
    if (to === this.current) throw new TransitionError(`já está em ${to}`);
    if (!ALLOWED_TRANSITIONS[this.current].includes(to)) throw new TransitionError(`transição não permitida: ${this.current} → ${to}`);
    if (to === 'MINERANDO') {
      if (!evidence?.processAlive) throw new TransitionError('MINERANDO exige processo do minerador ativo');
      const hr = evidence.minerHashrate;
      if (!hr || !(hr.value > 0) || this.now() - hr.at > 60_000) throw new TransitionError('MINERANDO exige hashrate medido pelo minerador no último minuto');
    }
    const t: Transition = { from: this.current, to, at: this.now(), origem, motivo };
    this.current = to;
    this.since = t.at;
    this.record(t);
    return t;
  }

  snapshot() {
    return { estado: this.current, desde: new Date(this.since).toISOString(), ultimaTransicao: this.log.at(-1) ?? null };
  }
}

// ---------------------------------------------------------------- indicadores independentes

export interface MetricLike {
  value: unknown;
  provenance: string;
  source: string;
  ts: number;
  unit?: string;
}

export interface Indicator {
  estado: string; // rótulo exibido (REAL, INDISPONÍVEL, HASHRATE NÃO MEDIDO...)
  valor?: number | string | boolean;
  unidade?: string;
  fonte?: string;
  atualizadoEm?: string;
  procedencia?: string;
  observacao?: string;
}

const FRESH_MS = 5 * 60_000;

function fromMetric(m: MetricLike | undefined, now: number, missingLabel: string, note?: string): Indicator {
  if (!m) return { estado: missingLabel };
  if (m.provenance !== 'real') return { estado: missingLabel, observacao: `valor ${m.provenance} não é usado como medição` };
  const stale = now - m.ts > FRESH_MS;
  return {
    estado: stale ? 'DADOS DESATUALIZADOS' : 'REAL',
    valor: m.value as number | string | boolean,
    unidade: m.unit,
    fonte: m.source,
    atualizadoEm: new Date(m.ts).toISOString(),
    procedencia: m.provenance,
    observacao: note,
  };
}

/** Monta os oito indicadores a partir das métricas gravadas. Nenhum depende de outro. */
export function buildIndicators(get: (key: string) => MetricLike | undefined, processAlive: boolean | undefined, now: number) {
  const shares = get('miner.shares_accepted');
  return {
    processoAtivo: processAlive === undefined
      ? { estado: 'NÃO IMPLEMENTADO', observacao: 'nenhum minerador de GPU verificado está integrado' }
      : { estado: processAlive ? 'REAL' : 'INATIVO', valor: processAlive, fonte: 'supervisor de processos' },
    gpuEmUso: fromMetric(get('gpu.utilization_pct'), now, 'INDISPONÍVEL', 'uso da GPU não comprova mineração'),
    hashrateLocal: fromMetric(get('miner.hashrate_hs'), now, 'HASHRATE NÃO MEDIDO'),
    workerConectado: (() => {
      const m = get('pool.connected');
      if (!m || m.provenance !== 'real' || m.value !== true) return { estado: 'POOL NÃO CONECTADA', observacao: m ? String(get('pool.fallback_reason')?.value ?? '') || undefined : undefined };
      return fromMetric(m, now, 'POOL NÃO CONECTADA');
    })(),
    sharesAceitas: shares && shares.provenance === 'real' && Number(shares.value) > 0
      ? fromMetric(shares, now, 'NENHUMA SHARE ACEITA CONFIRMADA')
      : { estado: 'NENHUMA SHARE ACEITA CONFIRMADA' },
    sharesRejeitadas: fromMetric(get('miner.shares_rejected'), now, 'INDISPONÍVEL'),
    saldoConfirmado: fromMetric(get('luxor.balance') ?? get('pool.balance'), now, 'INDISPONÍVEL', 'saldo informado pela pool (não é pagamento)'),
    pagamentosConfirmados: fromMetric(get('wallet.received_btc'), now, 'INDISPONÍVEL', 'somente transações verificadas na blockchain'),
  };
}
