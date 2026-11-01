// GET /api/dados — dados públicos e reais para o painel online (sem computador).
//  - Bitcoin em BRL e USD: Coinbase (https://api.coinbase.com/v2/prices/BTC-BRL/spot)
//  - Rede Bitcoin: mempool.space (altura, ajuste de dificuldade, taxas)
//  - Pearl (PRL) e Quantus (QUANTUS): WhatToMine (https://whattomine.com/coins.json)
// Cada fonte é independente: se uma falha, só ela aparece como indisponível. Resposta guardada 60 s na Vercel.
import { attempt, getJson, isNum, numLike, send } from './_lib.js';

const WTM_TAGS = { PRL: 'Pearl (PRL)', QUANTUS: 'Quantus (QTC)' };

export async function btc(fetchImpl) {
  const get = async (pair) => {
    const d = await getJson(`https://api.coinbase.com/v2/prices/${pair}/spot`, { fetchImpl });
    const v = numLike(d && d.data && d.data.amount);
    if (!(v > 0)) throw new Error(`cotação ${pair} fora do formato`);
    return v;
  };
  const [brl, usd] = await Promise.all([get('BTC-BRL'), get('BTC-USD')]);
  return { brl, usd, fonte: 'Coinbase', consultadoEm: new Date().toISOString() };
}

export async function rede(fetchImpl) {
  const base = 'https://mempool.space';
  const [altura, ajuste, taxas] = await Promise.all([
    getJson(`${base}/api/blocks/tip/height`, { fetchImpl }),
    getJson(`${base}/api/v1/difficulty-adjustment`, { fetchImpl }),
    getJson(`${base}/api/v1/fees/recommended`, { fetchImpl }),
  ]);
  const h = numLike(altura);
  if (!(h > 0)) throw new Error('altura do bloco fora do formato');
  return {
    altura: h,
    ajusteDificuldadePct: numLike(ajuste && ajuste.difficultyChange) ?? null,
    blocosAteAjuste: numLike(ajuste && ajuste.remainingBlocks) ?? null,
    taxas: { rapida: numLike(taxas && taxas.fastestFee) ?? null, meiaHora: numLike(taxas && taxas.halfHourFee) ?? null, economica: numLike(taxas && taxas.economyFee) ?? null, unidade: 'sat/vB' },
    fonte: 'mempool.space',
    consultadoEm: new Date().toISOString(),
  };
}

/** Mesmas regras do painel do computador: entrada fora do formato é descartada, nunca corrigida. */
export function parseCoins(json) {
  if (!json || typeof json !== 'object' || !json.coins || typeof json.coins !== 'object' || Array.isArray(json.coins)) throw new Error('resposta sem o campo "coins"');
  const out = {};
  for (const [name, o] of Object.entries(json.coins)) {
    if (!o || typeof o !== 'object') continue;
    const tag = typeof o.tag === 'string' ? o.tag.toUpperCase() : '';
    if (!(tag in WTM_TAGS)) continue;
    const blockTimeS = numLike(o.block_time);
    const ok = typeof o.algorithm === 'string' && blockTimeS > 0 && isNum(o.block_reward) && o.block_reward > 0
      && isNum(o.nethash) && o.nethash > 0 && isNum(o.exchange_rate) && o.exchange_rate > 0 && o.exchange_rate_curr === 'BTC'
      && typeof o.lagging === 'boolean' && isNum(o.timestamp) && o.timestamp > 0;
    if (!ok) continue;
    if (out[tag]) { out[tag] = { ambigua: true }; continue; }
    out[tag] = {
      tag, nome: WTM_TAGS[tag], nomeNaFonte: String(name).slice(0, 60), algoritmo: o.algorithm, blockTimeS, blockReward: o.block_reward,
      nethash: o.nethash, exchangeRateBtc: o.exchange_rate, atrasada: o.lagging, atualizadoEm: new Date(o.timestamp * 1000).toISOString(),
    };
  }
  return out;
}

export async function moedas(fetchImpl) {
  const found = parseCoins(await getJson('https://whattomine.com/coins.json', { fetchImpl, timeoutMs: 10000 }));
  const lista = Object.keys(WTM_TAGS).map((tag) => found[tag] && !found[tag].ambigua ? found[tag]
    : { tag, nome: WTM_TAGS[tag], indisponivel: found[tag] ? 'sigla ambígua na WhatToMine' : 'não encontrada ou fora do formato na WhatToMine' });
  return { lista, fonte: 'WhatToMine', consultadoEm: new Date().toISOString() };
}

export default async function handler(req, res, fetchImpl = globalThis.fetch) {
  if (req.method && req.method !== 'GET') return send(res, 405, { error: 'somente leitura (GET)' });
  const [b, r, m] = await Promise.all([attempt('Coinbase', () => btc(fetchImpl)), attempt('mempool.space', () => rede(fetchImpl)), attempt('WhatToMine', () => moedas(fetchImpl))]);
  send(res, 200, { geradoEm: new Date().toISOString(), btc: b, rede: r, moedas: m, mineracao: 'requer o computador com a RTX 3050' }, 60);
}
