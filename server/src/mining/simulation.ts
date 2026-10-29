// Simulação da seleção automática. Nunca inicia mineradores, não altera carteiras e não troca moedas de verdade.
// Cada passo representa uma reavaliação (padrão: 5 minutos).
import { activeCandidates, decide, evaluate, type Decision, type Evaluation, type SelectorConfig } from './selector.ts';
import type { MarketQuote } from './profitability.ts';

export const MODE_LABEL = 'SIMULAÇÃO';
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

export function runSimulation(steps: SimStep[], cfg: SelectorConfig, initialCurrent?: string): SimResult {
  let current = initialCurrent;
  let lastSwitchAt: number | undefined;
  let switches = 0;
  const records: SimRecord[] = [];
  for (const step of steps) {
    const evaluations = activeCandidates().map((coin) =>
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

/** Painel de leitura da seleção automática: sem fonte de mercado validada, tudo aparece como indisponível. */
export function autoMiningSnapshot(cfg: SelectorConfig, quotes: MarketQuote[], now: number) {
  const evaluations = activeCandidates().map((coin) =>
    evaluate(coin, quotes.find((q) => q.symbol === coin.symbol), cfg, now),
  );
  const decision = decide({ evaluations, now, cfg });
  return {
    modo: MODE_LABEL,
    avisoOperacao: 'Simulação: nenhum minerador é iniciado, nenhuma carteira é alterada e nenhuma troca é executada.',
    fonteMercado: quotes.length ? quotes.map((q) => q.source)[0] : 'indisponível (fonte de rentabilidade não validada)',
    decisao: decision,
    moedas: evaluations,
  };
}
