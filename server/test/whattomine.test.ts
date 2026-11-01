import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWtmCoins, WhatToMineSource, WTM_COINS_URL } from '../src/adapters/whattomine.ts';
import { buildQuote, expectedCoinsPerDay } from '../src/mining/quotes.ts';
import { findCoin } from '../src/mining/catalog.ts';
import { evaluate, DEFAULT_SELECTOR } from '../src/mining/selector.ts';
import { gpuHashrates } from '../src/config.ts';
import { RateLimiter, createHttpClient } from '../src/core/rateLimiter.ts';

// Valores copiados da resposta de https://whattomine.com/coins.json lida em 2026-10-29 (usados só como amostra de formato).
const PEARL = {
  id: 469, tag: 'PRL', algorithm: 'Pearl', block_time: '184.0', block_reward: 2211.650534870484,
  difficulty: 49459461.90290984, nethash: 75660874387190869565, exchange_rate: 0.000022322535840071432,
  exchange_rate_curr: 'BTC', lagging: false, timestamp: 1793298985,
};
const QUANTUS = {
  id: 473, tag: 'QUANTUS', algorithm: 'QPoW', block_time: '14.6354', block_reward: 0.29999999999999993,
  nethash: 31030601234100, exchange_rate: 0.0009660077384790912, exchange_rate_curr: 'BTC', lagging: false, timestamp: 1793299349,
};
const BODY = { coins: { Pearl: PEARL, Quantus: QUANTUS } };
const PEARL_TS = 1793298985 * 1000;

function fakeFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return handler(String(input));
  }) as typeof fetch;
  return { f, calls };
}
const okJson = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

test('WhatToMine: interpreta coins.json no formato publicado', () => {
  const r = parseWtmCoins(BODY);
  assert.equal(r.coins.length, 2);
  assert.equal(r.rejected.length, 0);
  const p = r.coins.find((c) => c.tag === 'PRL')!;
  assert.equal(p.blockTimeS, 184, 'block_time vem como texto e é convertido');
  assert.equal(p.algorithm, 'Pearl');
  assert.equal(p.timestampMs, PEARL_TS);
});

test('WhatToMine: entradas fora do formato são descartadas, não corrigidas', () => {
  const r = parseWtmCoins({ coins: {
    Pearl: PEARL,
    SemNethash: { ...PEARL, tag: 'AAA', nethash: undefined },
    EmDolar: { ...PEARL, tag: 'BBB', exchange_rate_curr: 'USD' },
    TempoTexto: { ...PEARL, tag: 'CCC', block_time: 'rápido' },
    ZeroRecompensa: { ...PEARL, tag: 'DDD', block_reward: 0 },
  } });
  assert.deepEqual(r.coins.map((c) => c.tag), ['PRL']);
  assert.equal(r.rejected.length, 4);
});

test('WhatToMine: resposta sem "coins" é erro', () => {
  assert.throws(() => parseWtmCoins({ erro: 'x' }), /coins/);
  assert.throws(() => parseWtmCoins({ coins: [] }), /formato/);
});

test('WhatToMine: consulta somente o endpoint público com GET', async () => {
  const { f, calls } = fakeFetch(() => okJson(BODY));
  const src = new WhatToMineSource(createHttpClient(new RateLimiter(100), f));
  const st = await src.coins();
  assert.equal(st.ok, true);
  assert.deepEqual(calls, [WTM_COINS_URL]);
});

test('WhatToMine: HTTP 403 vira indisponível com o motivo', async () => {
  const { f } = fakeFetch(() => new Response('proibido', { status: 403 }));
  const st = await new WhatToMineSource(createHttpClient(new RateLimiter(100), f)).coins();
  assert.equal(st.ok, false);
  assert.match(!st.ok ? st.reason : '', /indisponível.*403/);
});

test('WhatToMine: sem rede vira indisponível', async () => {
  const f = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  const st = await new WhatToMineSource(createHttpClient(new RateLimiter(100), f)).coins();
  assert.equal(st.ok, false);
  assert.match(!st.ok ? st.reason : '', /sem resposta/);
});

test('WhatToMine: JSON fora do formato vira indisponível', async () => {
  const { f } = fakeFetch(() => okJson({ outra: 'coisa' }));
  const st = await new WhatToMineSource(createHttpClient(new RateLimiter(100), f)).coins();
  assert.equal(st.ok, false);
});

test('WhatToMine: cache de 5 minutos evita consultas repetidas', async () => {
  let t = 1_000_000;
  const { f, calls } = fakeFetch(() => okJson(BODY));
  const src = new WhatToMineSource(createHttpClient(new RateLimiter(100), f), () => t);
  await src.coins();
  await src.coins();
  assert.equal(calls.length, 1);
  t += 5 * 60_000 + 1;
  await src.coins();
  assert.equal(calls.length, 2);
});

const coins = parseWtmCoins(BODY).coins;
const prl = findCoin('PRL')!;
const realBtc = { price: 600_000, ts: PEARL_TS + 60_000, provenance: 'real' };

test('cotação: sem hashrate da RTX 3060 não há número', () => {
  const r = buildQuote(prl, coins, undefined, realBtc);
  assert.equal(r.quote, undefined);
  assert.match(r.reason!, /GPU_HASHRATE_PRL/);
});

test('cotação: BTC simulado não é usado', () => {
  const r = buildQuote(prl, coins, 1e18, { ...realBtc, provenance: 'simulado' });
  assert.match(r.reason!, /não é real/);
});

test('cotação: sem cotação do BTC não há número', () => {
  assert.match(buildQuote(prl, coins, 1e18, undefined).reason!, /BTC/);
});

test('cotação: moeda marcada como atrasada não é usada', () => {
  const lag = parseWtmCoins({ coins: { Pearl: { ...PEARL, lagging: true } } }).coins;
  assert.match(buildQuote(prl, lag, 1e18, realBtc).reason!, /atrasados/);
});

test('cotação: algoritmo diferente do catálogo é recusado', () => {
  const other = parseWtmCoins({ coins: { Pearl: { ...PEARL, algorithm: 'Outro' } } }).coins;
  assert.match(buildQuote(prl, other, 1e18, realBtc).reason!, /algoritmo diverge/);
});

test('cotação: sigla ausente ou ambígua é recusada', () => {
  assert.match(buildQuote(prl, parseWtmCoins({ coins: { Quantus: QUANTUS } }).coins, 1e18, realBtc).reason!, /não encontrada/);
  const dup = parseWtmCoins({ coins: { Pearl: PEARL, Pearl2: { ...PEARL, id: 999 } } }).coins;
  assert.match(buildQuote(prl, dup, 1e18, realBtc).reason!, /ambígua/);
});

test('cotação: fórmula da fração do hashrate da rede', () => {
  const hr = 1e18;
  const r = buildQuote(prl, coins, hr, realBtc);
  const expected = (hr / PEARL.nethash) * PEARL.block_reward * (86_400 / 184);
  assert.ok(Math.abs(r.quote!.coinsPerDay - expected) < 1e-9 * expected);
  assert.ok(Math.abs(r.quote!.revenueLocalDay - expected * PEARL.exchange_rate * 600_000) < 1e-6);
  assert.equal(r.quote!.collectedAt, PEARL_TS, 'o dado mais antigo define a idade');
  assert.match(r.quote!.source, /estimado/);
  assert.equal(expectedCoinsPerDay(0, 1, 1, 1), 0);
});

test('cotação: dado da WhatToMine com 70 minutos não entra no cálculo', () => {
  const cfg = { ...DEFAULT_SELECTOR, energyCostDay: 1.512 };
  const r = buildQuote(prl, coins, 1e18, realBtc);
  const e = evaluate(prl, r.quote, cfg, PEARL_TS + 70 * 60_000);
  assert.equal(e.eligible, false);
  assert.match(e.reason, /desatualizados/);
});

test('cotação: Quantus em investigação nunca é avaliada, mesmo com dados', () => {
  const qtc = findCoin('QTC')!;
  const r = buildQuote(qtc, coins, 1e12, realBtc);
  const cfg = { ...DEFAULT_SELECTOR, energyCostDay: 1.512 };
  assert.equal(evaluate(qtc, r.quote, cfg, PEARL_TS).eligible, false);
});

test('config: GPU_HASHRATE_<SIGLA> aceita só números positivos', () => {
  const h = gpuHashrates({ GPU_HASHRATE_PRL: '1.5e18', GPU_HASHRATE_TST: '0', GPU_HASHRATE_XX: 'muito', GPU_HASHRATE_A: '5', OUTRA: '9' });
  assert.deepEqual(h, { PRL: 1.5e18 });
});
