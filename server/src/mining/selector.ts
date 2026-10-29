// Seleção de moeda com proteção contra trocas desnecessárias. Determinística; não usa LLM.
// Modo SIMULAÇÃO: esta função só decide. Ela não inicia, para nem troca nenhum minerador.
import { CATALOG, type CoinCandidate } from './catalog.ts';
import { DAY_MS, daysToPayout, isFresh, netDay, type MarketQuote, type NetResult } from './profitability.ts';

export const NOT_CALCULABLE = 'RENTABILIDADE NÃO CALCULÁVEL — FALTA DE DADOS REAIS';

export interface SelectorConfig {
  energyCostDay?: number; // custo diário de energia (modalidade escolhida); ausente = não calculável
  otherCostsDay?: number; // outros custos diários conhecidos
  minerFee: number; // taxa do minerador/software, fração (0 se não houver)
  horizonDays: number; // horizonte para comparar trocas (ex.: 1 dia)
  downtimeMin: number; // minutos parados durante uma troca
  minGainLocal: number; // ganho mínimo em BRL no horizonte para compensar a troca
  minGainPct: number; // ganho mínimo relativo ao resultado atual (0,1 = 10%)
  minSwitchIntervalMs: number; // intervalo mínimo entre trocas
  maxQuoteAgeMs: number; // dado mais velho que isso é tratado como indisponível
}

export const DEFAULT_SELECTOR: SelectorConfig = {
  minerFee: 0,
  horizonDays: 1,
  downtimeMin: 3,
  minGainLocal: 1,
  minGainPct: 0.1,
  minSwitchIntervalMs: 30 * 60_000,
  maxQuoteAgeMs: 15 * 60_000,
};

export interface Evaluation {
  symbol: string;
  name: string;
  algorithm: string;
  eligible: boolean;
  reason: string; // por que é ou não é elegível
  net?: NetResult;
  paybackDays?: number;
  quoteSource?: string;
  quoteAgeMin?: number;
}

export function evaluate(
  coin: CoinCandidate,
  quote: MarketQuote | undefined,
  cfg: SelectorConfig,
  now: number,
): Evaluation {
  const base = { symbol: coin.symbol, name: coin.name, algorithm: coin.algorithm };
  if (coin.status !== 'pool_validada' || !coin.pool) return { ...base, eligible: false, reason: 'em investigação: pool e minerador não verificados' };
  if (!quote) return { ...base, eligible: false, reason: `${NOT_CALCULABLE}: sem dados de receita (fonte indisponível)` };
  if (!isFresh(quote.collectedAt, now, cfg.maxQuoteAgeMs)) {
    return { ...base, eligible: false, reason: 'dados de rentabilidade desatualizados; não usados', quoteSource: quote.source };
  }
  if (cfg.energyCostDay === undefined) {
    return { ...base, eligible: false, reason: `${NOT_CALCULABLE}: custo de energia indisponível`, quoteSource: quote.source };
  }
  const net = netDay(quote.revenueLocalDay, coin.pool.poolFee, cfg.energyCostDay, cfg.minerFee, cfg.otherCostsDay ?? 0);
  const paybackDays = daysToPayout(quote.coinsPerDay, coin.pool.poolFee, coin.pool.minPayout);
  const quoteAgeMin = Math.round((now - quote.collectedAt) / 60_000);
  return {
    ...base,
    eligible: true,
    reason: net.netDay > 0 ? 'com resultado líquido estimado positivo' : 'resultado líquido estimado negativo',
    net,
    paybackDays,
    quoteSource: quote.source,
    quoteAgeMin,
  };
}

export type DecisionAction = 'manter' | 'trocar' | 'suspender' | 'aguardar_dados';

export interface Decision {
  action: DecisionAction;
  target?: string;
  reason: string;
  gainLocalHorizon?: number;
  switchCostLocal?: number;
}

export interface DecideInput {
  evaluations: Evaluation[];
  current?: string; // símbolo da moeda atual
  lastSwitchAt?: number;
  now: number;
  cfg: SelectorConfig;
}

export function decide(input: DecideInput): Decision {
  const { evaluations, current, lastSwitchAt, now, cfg } = input;
  const usable = evaluations.filter((e) => e.eligible && e.net);
  if (usable.length === 0) return { action: 'aguardar_dados', reason: 'nenhuma moeda com dados atuais e elegíveis' };

  const best = usable.reduce((a, b) => (b.net!.netDay > a.net!.netDay ? b : a));
  if (best.net!.netDay <= 0) {
    return { action: 'suspender', reason: 'todas as alternativas têm resultado líquido estimado negativo' };
  }
  if (!current) return { action: 'trocar', target: best.symbol, reason: 'nenhuma moeda atual; escolha da melhor alternativa' };
  if (best.symbol === current) return { action: 'manter', target: current, reason: 'a moeda atual já é a melhor alternativa' };

  const cur = evaluations.find((e) => e.symbol === current);
  if (!cur || !cur.eligible || !cur.net) {
    return { action: 'manter', target: current, reason: 'dados da moeda atual indisponíveis; não troca no escuro' };
  }
  if (lastSwitchAt !== undefined && now - lastSwitchAt < cfg.minSwitchIntervalMs) {
    return { action: 'manter', target: current, reason: 'intervalo mínimo entre trocas ainda não passou' };
  }

  const curNet = cur.net.netDay;
  const bestNet = best.net!.netDay;
  const gain = (bestNet - curNet) * cfg.horizonDays;
  // Parar durante a troca custa o resultado líquido que a moeda atual geraria nesse tempo.
  const switchCost = (Math.max(curNet, 0) * cfg.downtimeMin * 60_000) / DAY_MS;
  const relativeOk = curNet <= 0 || bestNet >= curNet * (1 + cfg.minGainPct);
  const netBenefit = gain - switchCost;

  if (relativeOk && netBenefit >= cfg.minGainLocal) {
    return {
      action: 'trocar',
      target: best.symbol,
      reason: `ganho estimado de ${netBenefit.toFixed(2)} BRL no horizonte, após custo da parada`,
      gainLocalHorizon: gain,
      switchCostLocal: switchCost,
    };
  }
  return {
    action: 'manter',
    target: current,
    reason: 'vantagem estimada não compensa a parada e as taxas',
    gainLocalHorizon: gain,
    switchCostLocal: switchCost,
  };
}

/** Candidatas do catálogo que a simulação pode avaliar (investigar fica de fora por construção). */
export function activeCandidates(): CoinCandidate[] {
  return CATALOG.filter((c) => c.status === 'pool_validada');
}
