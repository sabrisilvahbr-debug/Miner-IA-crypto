// Funções da Vercel do painel online (api/dados.js e api/carteira.js), com as fontes simuladas por um fetch falso.
// Os formatos usados aqui são os reais: Coinbase, mempool.space, WhatToMine (coins.json) e a OpenAPI da Kryptex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Handler = (req: { method: string; url: string }, res: FakeRes, fetchImpl: typeof fetch) => Promise<void>;
interface FakeRes { statusCode: number; headers: Record<string, string>; body: string; setHeader(k: string, v: string): void; end(b: string): void }

const load = async (f: string) => (await import(pathToFileURL(resolve('api', f)).href)) as { default: Handler; parseCoins?: (j: unknown) => Record<string, unknown> };

function res(): FakeRes {
  return { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
}

const PRL = { id: 469, tag: 'PRL', algorithm: 'Pearl', block_time: '184.0', block_reward: 2211.650534870484, nethash: 75660874387190869565, exchange_rate: 0.000022322535840071432, exchange_rate_curr: 'BTC', lagging: false, timestamp: 1793298985 };
const QUANTUS = { id: 473, tag: 'QUANTUS', algorithm: 'QPoW', block_time: '14.6354', block_reward: 0.3, nethash: 31030601234100, exchange_rate: 0.0009660077384790912, exchange_rate_curr: 'BTC', lagging: false, timestamp: 1793299349 };

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    if (!key) return new Response('nao encontrado', { status: 404 });
    const v = routes[key];
    if (v instanceof Error) throw v;
    return new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const OK_ROUTES = {
  'https://api.coinbase.com/v2/prices/BTC-BRL/spot': { data: { amount: '424958.98', currency: 'BRL' } },
  'https://api.coinbase.com/v2/prices/BTC-USD/spot': { data: { amount: '76000.10', currency: 'USD' } },
  'https://mempool.space/api/blocks/tip/height': 921000,
  'https://mempool.space/api/v1/difficulty-adjustment': { difficultyChange: 1.84, remainingBlocks: 512 },
  'https://mempool.space/api/v1/fees/recommended': { fastestFee: 6, halfHourFee: 4, hourFee: 3, economyFee: 2 },
  'https://whattomine.com/coins.json': { coins: { Pearl: PRL, Quantus: QUANTUS, Bitcoin: { tag: 'BTC' } } },
};

test('painel online /api/dados: junta Coinbase, mempool.space e WhatToMine com fonte e horário', async () => {
  const { default: h } = await load('dados.js');
  const calls: string[] = [];
  const r = res();
  await h({ method: 'GET', url: '/api/dados' }, r, fakeFetch(OK_ROUTES, calls));
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['cache-control'], /s-maxage=60/);
  const j = JSON.parse(r.body);
  assert.equal(j.btc.ok, true);
  assert.equal(j.btc.brl, 424958.98);
  assert.equal(j.rede.altura, 921000);
  assert.equal(j.rede.taxas.rapida, 6);
  const prl = j.moedas.lista.find((c: { tag: string }) => c.tag === 'PRL');
  assert.equal(prl.nethash, PRL.nethash);
  assert.equal(prl.blockTimeS, 184);
  assert.equal(prl.atualizadoEm, new Date(PRL.timestamp * 1000).toISOString());
  assert.match(j.mineracao, /requer o computador/);
  assert.ok(calls.every((u) => /^https:\/\/(api\.coinbase\.com|mempool\.space|whattomine\.com)\//.test(u)), 'só fontes fixas');
});

test('painel online /api/dados: uma fonte fora do ar não derruba as outras', async () => {
  const { default: h } = await load('dados.js');
  const r = res();
  await h({ method: 'GET', url: '/api/dados' }, r, fakeFetch({ ...OK_ROUTES, 'https://whattomine.com/coins.json': new Error('bloqueado') }));
  const j = JSON.parse(r.body);
  assert.equal(j.btc.ok, true);
  assert.equal(j.moedas.ok, false);
  assert.match(j.moedas.motivo, /WhatToMine: bloqueado/);
});

test('painel online: entrada da WhatToMine fora do formato é descartada, nunca corrigida', async () => {
  const { parseCoins } = await load('dados.js');
  const out = parseCoins!({ coins: { Pearl: { ...PRL, exchange_rate_curr: 'USD' }, Quantus: QUANTUS } });
  assert.equal(out.PRL, undefined);
  assert.ok(out.QUANTUS);
  assert.throws(() => parseCoins!({ nada: 1 }), /coins/);
});

test('painel online /api/dados: só aceita leitura', async () => {
  const { default: h } = await load('dados.js');
  const r = res();
  await h({ method: 'POST', url: '/api/dados' }, r, fakeFetch(OK_ROUTES));
  assert.equal(r.statusCode, 405);
});

const ADDR = 'prl1qexemploenderecopublico0000';
const K = `https://pool.kryptex.com/prl`;

test('painel online /api/carteira: consulta só as rotas documentadas da Kryptex para o endereço', async () => {
  const { default: h } = await load('carteira.js');
  const calls: string[] = [];
  const r = res();
  await h({ method: 'GET', url: `/api/carteira?endereco=${ADDR}` }, r, fakeFetch({
    [`${K}/api/v1/miner/balance/${ADDR}`]: { total: 0.42, threshold: 1, reached_pct: 42, unconfirmed: 0.02, confirmed: 0.4 },
    [`${K}/api/v1/miner/payouts/${ADDR}/stats`]: { paid: 3, unpaid: 0.42, reward: { week: 2.1, month: 8.3 } },
    [`${K}/api/v1/miner/payouts/${ADDR}`]: { count: 1, results: [{ date: 1793298985, received: 1.01, txid: 'abc123def456', status: 'paid' }] },
    [`${K}/api/v3/miner/workers/${ADDR}`]: { count: 1, results: [{ worker: 'rtx3050', scheme: 'pps', hashrate: 25.1, shares: 40, last_share: 1793298985 }] },
  }, calls));
  assert.equal(r.statusCode, 200);
  const j = JSON.parse(r.body);
  assert.deepEqual([j.saldo.total, j.saldo.limitePagamento, j.saldo.atingidoPct], [0.42, 1, 42]);
  assert.equal(j.resumoPagamentos.aReceber, 0.42);
  assert.equal(j.workers.lista[0].nome, 'rtx3050');
  assert.equal(j.pagamentos.ultimos[0].statusNaPool, 'paid');
  assert.match(j.aviso, /não foram conferidos na blockchain/);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((u) => u.startsWith(`${K}/api/`) && u.includes(ADDR)));
});

test('painel online /api/carteira: recusa endereço inválido e texto que pareça frase-semente, sem consultar nada', async () => {
  const { default: h } = await load('carteira.js');
  for (const e of ['', 'curto', 'abandon ability able about above absent absorb abstract', `${ADDR}/../../admin`, 'https://evil.example.com/x']) {
    const calls: string[] = [];
    const r = res();
    await h({ method: 'GET', url: `/api/carteira?endereco=${encodeURIComponent(e)}` }, r, fakeFetch({}, calls));
    assert.equal(r.statusCode, 400, e);
    assert.equal(calls.length, 0, 'nenhuma consulta externa');
  }
});

test('painel online /api/carteira: endereço sem histórico na pool aparece como indisponível, sem inventar saldo', async () => {
  const { default: h } = await load('carteira.js');
  const r = res();
  await h({ method: 'GET', url: `/api/carteira?endereco=${ADDR}` }, r, fakeFetch({}));
  const j = JSON.parse(r.body);
  assert.equal(j.saldo.ok, false);
  assert.match(j.saldo.motivo, /HTTP 404/);
  assert.equal(j.saldo.total, undefined);
});
