// Monta a cotação de rentabilidade (MarketQuote) a partir de dados reais: WhatToMine + cotação BTC na moeda local
// + hashrate da RTX 3050 informado pelo operador. Se faltar qualquer peça, devolve o motivo e nenhuma cotação.
//
// Fórmula (fração do hashrate da rede): moedas/dia = (hashrate / nethash) × recompensa × 86400 / tempo_de_bloco
// O resultado é sempre ESTIMADO. O hashrate precisa estar na mesma unidade do "nethash" da WhatToMine,
// que não é documentada: confira comparando com a calculadora do site antes de confiar no número.
import type { CoinCandidate } from './catalog.ts';
import type { MarketQuote } from './profitability.ts';
import type { WtmCoin } from '../adapters/whattomine.ts';

export interface LocalBtcPrice {
  price: number; // 1 BTC na moeda local
  ts: number;
  provenance: string; // só "real" é aceito
}

export type QuoteResult = { quote: MarketQuote; reason?: undefined } | { quote?: undefined; reason: string };

export function expectedCoinsPerDay(hashrate: number, nethash: number, blockReward: number, blockTimeS: number): number {
  return (hashrate / nethash) * blockReward * (86_400 / blockTimeS);
}

export function buildQuote(
  coin: CoinCandidate,
  wtm: WtmCoin[] | undefined,
  hashrate: number | undefined,
  btc: LocalBtcPrice | undefined,
): QuoteResult {
  if (!coin.wtmTag) return { reason: 'moeda sem sigla na WhatToMine' };
  if (!wtm) return { reason: 'dados da WhatToMine indisponíveis' };
  const matches = wtm.filter((c) => c.tag === coin.wtmTag);
  if (matches.length === 0) return { reason: `sigla ${coin.wtmTag} não encontrada na WhatToMine` };
  if (matches.length > 1) return { reason: `sigla ${coin.wtmTag} ambígua na WhatToMine (${matches.length} entradas)` };
  const w = matches[0];
  if (coin.wtmAlgorithm && w.algorithm !== coin.wtmAlgorithm) {
    return { reason: `algoritmo diverge: catálogo ${coin.wtmAlgorithm}, WhatToMine ${w.algorithm}` };
  }
  if (w.lagging) return { reason: 'WhatToMine marca os dados desta moeda como atrasados' };
  if (!(hashrate && hashrate > 0)) return { reason: `hashrate da RTX 3050 não informado (GPU_HASHRATE_${coin.symbol})` };
  if (!btc) return { reason: 'cotação do BTC em moeda local indisponível' };
  if (btc.provenance !== 'real') return { reason: `cotação do BTC não é real (${btc.provenance}); não usada` };
  const coinsPerDay = expectedCoinsPerDay(hashrate, w.nethash, w.blockReward, w.blockTimeS);
  return {
    quote: {
      symbol: coin.symbol,
      coinsPerDay,
      revenueLocalDay: coinsPerDay * w.exchangeRateBtc * btc.price,
      collectedAt: Math.min(w.timestampMs, btc.ts), // o dado mais antigo define a idade
      source: 'whattomine+coinbase (estimado)',
    },
  };
}
