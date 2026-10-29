import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LuxorClient, LuxorPool, luxorMinerConfig, maskKey } from '../src/adapters/luxor.ts';
import { testConfig } from '../src/config.ts';
import { makeApp } from './helpers.ts';

const KEY = 'api-teste-0000000000000000000000000000';
const BASE = 'https://app.luxor.tech/api/v2';

const WORKSPACE = { id: '7b1c2d3e-0000-4000-8000-000000000001', name: 'Minha empresa', products: ['POOL'], sites: [] };
const summary = (active: number) => ({
  currency_type: 'BTC', subaccounts: [{ id: 1, name: 'fazenda' }],
  hashrate_5m: '110000000000000', hashrate_1h: '1', hashrate_24h: '1', hashrate_stale_1h: '0', hashrate_stale_24h: '0',
  efficiency_5m: 99.1, uptime_24h: 98.7, active_miners: active,
  revenue_24h: [{ currency_type: 'BTC', revenue_type: 'MINING', revenue: 0.0004 }],
  revenue_all_time: [{ currency_type: 'BTC', revenue_type: 'MINING', revenue: 0.12 }],
  hashprice: [{ currency_type: 'BTC', value: 0.00000045 }],
  balance: [{ currency_type: 'BTC', revenue: 0.0031 }],
});

function fakeLuxor(routes: Record<string, { status: number; body: unknown }>) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization') });
    const path = new URL(url).pathname.replace('/api/v2', '');
    const r = routes[path];
    if (!r) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'não encontrado' } }), { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

const cfg = (o = {}) => testConfig({ poolSource: 'luxor', luxorApiKey: KEY, luxorApiUrl: BASE, luxorCurrency: 'BTC', ...o });

test('Luxor: envia a chave no cabeçalho authorization, sem "Bearer", e só usa GET', async () => {
  const { f, calls } = fakeLuxor({ '/workspace': { status: 200, body: WORKSPACE } });
  await new LuxorClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: f }).get('/workspace');
  assert.equal(calls[0].url, `${BASE}/workspace`);
  assert.equal(calls[0].auth, KEY);
  assert.equal(calls[0].method, 'GET');
});

test('Luxor: caminhos de escrita ou desconhecidos são recusados antes de qualquer requisição', async () => {
  const { f, calls } = fakeLuxor({});
  const c = new LuxorClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: f });
  await assert.rejects(c.get('/pool/payment-settings/BTC'), /não permitido/);
  await assert.rejects(c.get('/workspace/sites'), /não permitido/);
  assert.equal(calls.length, 0);
});

test('Luxor: nenhuma consulta de dados antes da autenticação ser aceita', async () => {
  const { f, calls } = fakeLuxor({ '/workspace': { status: 401, body: { error: { code: 'unauthorized', message: 'invalid key' } } }, '/pool/summary/BTC': { status: 200, body: summary(3) } });
  const pool = new LuxorPool(new LuxorClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: f }), cfg());
  const s = await pool.stats();
  assert.equal(calls.length, 1, 'somente /workspace foi chamado');
  assert.equal(pool.validation.state, 'falhou');
  assert.equal(pool.validation.httpStatus, 401);
  assert.match(s.fallbackReason!, /INDISPONÍVEL.*não validada/);
  assert.equal(s.balance, undefined, 'sem autenticação não existe saldo — nada é simulado');
  assert.equal(s.hashrateHs, undefined);
});

test('Luxor: autenticada com mineradores ativos → dados reais e verificados', async () => {
  const { f } = fakeLuxor({ '/workspace': { status: 200, body: WORKSPACE }, '/pool/summary/BTC': { status: 200, body: summary(3) } });
  const pool = new LuxorPool(new LuxorClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: f }), cfg());
  const s = await pool.stats();
  assert.equal(pool.validation.state, 'validada');
  assert.equal(pool.validation.dataVerified, true);
  assert.equal(s.provenance, 'real');
  assert.equal(s.balance, 0.0031);
  assert.equal(s.luxor?.activeMiners, 3);
  assert.equal(s.hashrateHs, undefined, 'unidade do hashrate não é documentada: não é convertida');
});

test('Luxor: autenticada mas sem mineradores ativos → dados reais da conta e POOL NÃO CONECTADA', async () => {
  const { f } = fakeLuxor({ '/workspace': { status: 200, body: WORKSPACE }, '/pool/summary/BTC': { status: 200, body: summary(0) } });
  const pool = new LuxorPool(new LuxorClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: f }), cfg());
  const s = await pool.stats();
  assert.equal(pool.validation.state, 'validada');
  assert.equal(s.provenance, 'real');
  assert.match(s.fallbackReason!, /POOL NÃO CONECTADA.*nenhum minerador ativo/);
  assert.equal(s.luxor?.balance, 0.0031, 'os dados reais da conta continuam disponíveis em luxor.*');
});

test('Luxor: resposta fora do esquema não é aceita como validação', async () => {
  const { f } = fakeLuxor({ '/workspace': { status: 200, body: { ok: true } } });
  const pool = new LuxorPool(new LuxorClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: f }), cfg());
  await pool.stats();
  assert.equal(pool.validation.state, 'resposta_invalida');
  assert.equal(pool.validation.dataVerified, false);
});

test('Luxor: API inacessível → INDISPONÍVEL, sem lançar erro e sem dados inventados', async () => {
  const f = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as typeof fetch;
  const pool = new LuxorPool(new LuxorClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: f }), cfg());
  const s = await pool.stats();
  assert.equal(pool.validation.state, 'inacessivel');
  assert.match(s.fallbackReason!, /INDISPONÍVEL/);
  assert.equal(s.balance, undefined);
});

test('Luxor: a chave nunca aparece em erros, logs, API ou métricas', async () => {
  const lines: string[] = [];
  const { f } = fakeLuxor({ '/workspace': { status: 403, body: { error: { code: 'forbidden', message: `chave ${KEY} sem permissão` } } } });
  const app = makeApp(cfg(), { fetchImpl: f, logger: { log: (_s, m, d) => lines.push(m + JSON.stringify(d ?? {})), child() { return this; } } });
  await app.runtime.runOnce(21);
  await app.runtime.runOnce(27);
  const dump = JSON.stringify({ v: app.luxor?.validation, metrics: app.store.latestMetrics(), events: app.store.listEvents({ limit: 200 }), lines });
  assert.ok(!dump.includes(KEY), 'chave vazou');
  assert.match(app.luxor!.validation.message, /\*\*\*/);
  assert.equal(maskKey(KEY), 'api-…0000');
});

test('Luxor: agente 21 publica estado da autenticação e o motivo de a pool não estar conectada', async () => {
  const { f } = fakeLuxor({ '/workspace': { status: 200, body: WORKSPACE }, '/pool/summary/BTC': { status: 200, body: summary(0) } });
  const app = makeApp(cfg(), { fetchImpl: f });
  await app.runtime.runOnce(21);
  assert.equal(app.store.latestMetric('luxor.auth')?.value, 'validada');
  assert.equal(app.store.latestMetric('luxor.data_verified')?.value, true);
  assert.equal(app.store.latestMetric('luxor.active_miners')?.provenance, 'real');
  assert.equal(app.store.latestMetric('pool.source_mode')?.value, 'indisponível');
  assert.equal(app.store.latestMetric('pool.connected')?.value, false);
  assert.match(String(app.store.latestMetric('pool.fallback_reason')?.value), /nenhum minerador ativo/);
  assert.equal(app.runtime.agent(21)?.state, 'operacional');
});

test('Luxor: configuração do minerador usa os dados do guia oficial e exige subconta', () => {
  const sem = luxorMinerConfig(cfg());
  assert.equal(sem.ready, false);
  assert.equal(sem.url, 'stratum+tcp://btc.global.luxor.tech:700');
  assert.equal(sem.worker, undefined);
  const com = luxorMinerConfig(cfg({ luxorSubaccount: 'fazenda', luxorWorkerName: 's19a01' }));
  assert.equal(com.ready, true);
  assert.equal(com.worker, 'fazenda.s19a01');
  assert.equal(luxorMinerConfig(cfg({ luxorCurrency: 'LTC_DOGE' })).url, 'stratum+tcp://ltc.global.luxor.tech:700');
  assert.equal(luxorMinerConfig(cfg({ luxorSubaccount: 'faz@1', luxorWorkerName: 'x' })).ready, false);
});
