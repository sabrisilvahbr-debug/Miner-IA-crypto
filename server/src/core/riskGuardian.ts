// Guardião de Risco: regras determinísticas e verificáveis. Nenhuma decisão aqui depende de LLM.
import type { ActionKind, ActionProposal, Provenance } from './types.ts';
import type { Store } from './store.ts';
import type { AppConfig } from '../config.ts';

export const FORBIDDEN_KINDS: ActionKind[] = ['withdraw', 'purchase', 'payment', 'trade'];
export const AUTOMATABLE_KINDS: ActionKind[] = ['pause_miner', 'resume_miner', 'restart_miner', 'switch_pool', 'adjust_threads'];

export interface PauseState {
  paused: boolean;
  reason?: string;
  by?: string;
  since?: number;
}

export interface RiskSnapshot {
  now: number;
  pause: PauseState;
  temperatureC?: number;
  minerProvenance: Provenance;
  restartsLastHour: number;
  actionsLastHour: number;
}

export interface ActionRule {
  id: string;
  description: string;
  check(a: Pick<ActionProposal, 'kind' | 'params' | 'evidence'>, s: RiskSnapshot, c: AppConfig): string | null;
}

export const ACTION_RULES: ActionRule[] = [
  {
    id: 'R01',
    description: 'Compras, pagamentos, saques e negociações nunca são executados automaticamente.',
    check: (a) => (FORBIDDEN_KINDS.includes(a.kind) ? `R01: operação financeira "${a.kind}" é proibida para automação` : null),
  },
  {
    id: 'R02',
    description: 'Tipos de ação desconhecidos são bloqueados.',
    check: (a) => (FORBIDDEN_KINDS.includes(a.kind) || AUTOMATABLE_KINDS.includes(a.kind) ? null : `R02: tipo de ação desconhecido "${a.kind}"`),
  },
  {
    id: 'R03',
    description: 'Com o sistema pausado, apenas a pausa do minerador é permitida.',
    check: (a, s) => (s.pause.paused && a.kind !== 'pause_miner' ? 'R03: sistema pausado pelo Guardião de Risco' : null),
  },
  {
    id: 'R04',
    description: 'Ações sobre um minerador real não podem ser motivadas por dados simulados ou de teste.',
    check: (a, s) =>
      s.minerProvenance === 'real' && (a.evidence === 'simulado' || a.evidence === 'teste')
        ? `R04: evidência "${a.evidence}" não autoriza ação em minerador real`
        : null,
  },
  {
    id: 'R05',
    description: 'Limite de reinícios do minerador por hora.',
    check: (a, s, c) =>
      a.kind === 'restart_miner' && s.restartsLastHour >= c.maxRestartsPerHour
        ? `R05: limite de ${c.maxRestartsPerHour} reinícios/hora atingido`
        : null,
  },
  {
    id: 'R06',
    description: 'Limite total de ações por hora.',
    check: (_a, s, c) => (s.actionsLastHour >= c.maxActionsPerHour ? `R06: limite de ${c.maxActionsPerHour} ações/hora atingido` : null),
  },
  {
    id: 'R07',
    description: 'Troca de pool apenas para pools da lista ALLOWED_POOLS.',
    check: (a, _s, c) => {
      if (a.kind !== 'switch_pool') return null;
      const pool = String(a.params.pool ?? '');
      return c.allowedPools.includes(pool) ? null : `R07: pool "${pool || '(vazia)'}" fora da lista permitida`;
    },
  },
  {
    id: 'R08',
    description: 'Não aumentar carga nem retomar mineração com temperatura acima do limite.',
    check: (a, s, c) =>
      (a.kind === 'resume_miner' || a.kind === 'adjust_threads') && s.temperatureC !== undefined && s.temperatureC >= c.maxTempC
        ? `R08: temperatura ${s.temperatureC} °C ≥ limite ${c.maxTempC} °C`
        : null,
  },
];

export interface Evaluation {
  allowed: boolean;
  reasons: string[];
}

export class RiskGuardian {
  private store: Store;
  private config: AppConfig;
  private now: () => number;
  minerProvenance: Provenance = 'simulado';

  constructor(store: Store, config: AppConfig, now: () => number = Date.now) {
    this.store = store;
    this.config = config;
    this.now = now;
  }

  pauseState(): PauseState {
    return this.store.getKV<PauseState>('system.pause', { paused: false });
  }

  pause(reason: string, by: string): PauseState {
    const s: PauseState = { paused: true, reason, by, since: this.now() };
    this.store.setKV('system.pause', s, this.now());
    return s;
  }

  /** Retomar exige que nenhuma condição crítica esteja ativa. */
  resume(by: string): { ok: boolean; reason?: string; state: PauseState } {
    const temp = this.temperature();
    if (temp !== undefined && temp >= this.config.criticalTempC) {
      return { ok: false, reason: `temperatura crítica (${temp} °C) ainda ativa`, state: this.pauseState() };
    }
    const s: PauseState = { paused: false, by, since: this.now() };
    this.store.setKV('system.pause', s, this.now());
    return { ok: true, state: s };
  }

  private temperature(): number | undefined {
    const m = this.store.latestMetric('miner.temperature_c');
    if (!m || typeof m.value !== 'number') return undefined;
    // Leituras com mais de 5 minutos não contam como estado atual.
    return this.now() - m.ts < 300_000 ? m.value : undefined;
  }

  snapshot(): RiskSnapshot {
    const hourAgo = this.now() - 3_600_000;
    return {
      now: this.now(),
      pause: this.pauseState(),
      temperatureC: this.temperature(),
      minerProvenance: this.minerProvenance,
      restartsLastHour: this.store.countActionsSince(hourAgo, 'restart_miner', ['executada']),
      actionsLastHour: this.store.countActionsSince(hourAgo, undefined, ['executada']),
    };
  }

  evaluate(a: Pick<ActionProposal, 'kind' | 'params' | 'evidence'>, snap = this.snapshot()): Evaluation {
    const reasons: string[] = [];
    for (const rule of ACTION_RULES) {
      const r = rule.check(a, snap, this.config);
      if (r) reasons.push(r);
    }
    return { allowed: reasons.length === 0, reasons };
  }

  /** Regras de estado contínuas. Retorna achados; pausa o sistema em condição crítica. */
  checkState(): { level: 'normal' | 'atencao' | 'critico'; findings: string[]; paused: boolean } {
    const findings: string[] = [];
    let level: 'normal' | 'atencao' | 'critico' = 'normal';
    const temp = this.temperature();
    if (temp !== undefined && temp >= this.config.criticalTempC) {
      findings.push(`S01: temperatura crítica ${temp} °C (limite ${this.config.criticalTempC} °C)`);
      level = 'critico';
      if (!this.pauseState().paused) this.pause(`temperatura crítica ${temp} °C`, 'guardiao');
    } else if (temp !== undefined && temp >= this.config.maxTempC) {
      findings.push(`S02: temperatura elevada ${temp} °C (limite ${this.config.maxTempC} °C)`);
      level = 'atencao';
    }
    const rej = this.store.latestMetric('miner.reject_rate_pct');
    if (rej && typeof rej.value === 'number' && rej.value > this.config.maxRejectRatePct) {
      findings.push(`S03: taxa de rejeição ${rej.value.toFixed(2)}% acima de ${this.config.maxRejectRatePct}%`);
      if (level === 'normal') level = 'atencao';
    }
    const wallet = this.store.latestMetric('wallet.address');
    if (
      this.config.allowedWallets.length &&
      wallet &&
      wallet.provenance === 'real' &&
      !this.config.allowedWallets.includes(String(wallet.value))
    ) {
      findings.push('S04: endereço de carteira monitorado fora da lista ALLOWED_WALLETS');
      level = 'critico';
    }
    return { level, findings, paused: this.pauseState().paused };
  }

  rules(): { id: string; description: string }[] {
    return [
      ...ACTION_RULES.map((r) => ({ id: r.id, description: r.description })),
      { id: 'S01', description: `Temperatura ≥ ${this.config.criticalTempC} °C pausa o sistema automaticamente.` },
      { id: 'S02', description: `Temperatura ≥ ${this.config.maxTempC} °C gera estado de atenção.` },
      { id: 'S03', description: `Taxa de rejeição de shares acima de ${this.config.maxRejectRatePct}% gera atenção.` },
      { id: 'S04', description: 'Carteira monitorada fora da lista permitida gera estado crítico.' },
      { id: 'H01', description: 'Toda ação aprovada pelas regras ainda exige aprovação do operador antes de executar.' },
    ];
  }
}
