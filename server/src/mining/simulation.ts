// Seleção automática de moeda: decisão sobre dados fornecidos. Nunca inicia mineradores, não altera carteiras
// e não troca moedas de verdade. runSimulation reproduz uma sequência de dados (usado nos testes automatizados);
// autoMiningSnapshot avalia os dados reais atuais. Cada passo representa uma reavaliação (padrão: 5 minutos).
import { activeCandidates, decide, evaluate, type Decision, type Evaluation, type SelectorConfig } from './selector.ts';
import type { CoinCandidate } from './catalog.ts';
import type { MarketQuote } from './profitability.ts';

export const MODE_LABEL = 'RECOMENDAÇÃO — MINERAÇÃO DESATIVADA';
export const REEVALUATE_EVERY_MS = 5 * 60_000;

export interface SimStep {
  now: number;
  quotes: MarketQuote[]; // use [] para simular falha de fonte
}

export interface SimRecord {
  now: number;
  evaluations: Evaluation[];
  decision: Decision;
  current?: string;
}

export interface SimResult {
  modo: typeof MODE_LABEL;
  records: SimRecord[];
  switches: number;
  finalCurrent?: string;
}

export function runSimulation(steps: SimStep[], cfg: SelectorConfig, initialCurrent?: string, candidates: CoinCandidate[] = activeCandidates()): SimResult {
  let current = initialCurrent;
  let lastSwitchAt: number | undefined;
  let switches = 0;
  const records: SimRecord[] = [];
  for (const step of steps) {
    const evaluations = candidates.map((coin) =>
      evaluate(coin, step.quotes.find((q) => q.symbol === coin.symbol), cfg, step.now),
    );
    const decision = decide({ evaluations, current, lastSwitchAt, now: step.now, cfg });
    records.push({ now: step.now, evaluations, decision, current });
    if (decision.action === 'trocar' && decision.target) {
      if (current !== undefined) switches++;
      current = decision.target;
      lastSwitchAt = step.now;
    } else if (decision.action === 'suspender') {
      current = undefined;
    }
  }
  return { modo: MODE_LABEL, records, switches, finalCurrent: current };
}

/** Painel de leitura da seleção automática. "motivos" explica, por moeda, por que não há cotação atual. */
export function autoMiningSnapshot(
  cfg: SelectorConfig,
  quotes: MarketQuote[],
  now: number,
  opts: { motivos?: Record<string, string>; fonte?: string; candidates?: CoinCandidate[] } = {},
) {
  const candidates = opts.candidates ?? activeCandidates();
  const evaluations = candidates.map((coin) => {
    const e = evaluate(coin, quotes.find((q) => q.symbol === coin.symbol), cfg, now);
    const motivo = opts.motivos?.[coin.symbol];
    return !e.eligible && motivo && !quotes.some((q) => q.symbol === coin.symbol) ? { ...e, reason: motivo } : e;
  });
  const decision = decide({ evaluations, now, cfg });
  return {
    modo: MODE_LABEL,
    avisoOperacao: 'Somente recomendação: nenhum minerador é iniciado, nenhuma carteira é alterada e nenhuma troca é executada.',
    fonteMercado: opts.fonte ?? (quotes.length ? quotes[0].source : 'INDISPONÍVEL (fonte de rentabilidade não habilitada)'),
    decisao: decision,
    moedas: evaluations,
  };
}
