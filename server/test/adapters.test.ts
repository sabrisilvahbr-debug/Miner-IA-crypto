import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { RateLimiter, createHttpClient, RateLimitedError } from '../src/core/rateLimiter.ts';
import { XmrigAdapter, CgminerAdapter, MinerService, SimulatedMinerAdapter } from '../src/adapters/miner.ts';
import { CoinbaseMarket, MempoolWallet, JsonPool, readPath } from '../src/adapters/external.ts';
import { testConfig } from '../src/config.ts';
import { redact } from '../src/core/logger.ts';

function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return new Response('nf', { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

test('limitador de chamadas contém excesso por host', () => {
  let t = 0;
  const l = new RateLimiter(2, () => t);
  assert.equal(l.tryTake('a'), true);
  assert.equal(l.tryTake('a'), true);
  assert.equal(l.tryTake('a'), false);
  assert.equal(l.tryTake('b'), true, 'hosts independentes');
  t += 30_000;
  assert.equal(l.tryTake('a'), true, 'fichas repostas com o tempo');
});

test('cliente HTTP lança RateLimitedError quando contido', async () => {
  const { f } = fakeFetch({ '/x': {} });
  const http = createHttpClient(new RateLimiter(1), f);
  await http.getJson('https://h.test/x');
  await assert.rejects(http.getJson('https://h.test/x'), RateLimitedError);
});

test('XMRig: interpreta /2/summary', async () => {
  const { f, calls } = fakeFetch({ '/2/summary': { version: '6.22.0', algo: 'rx/0', hashrate: { total: [5000.5, 4900, 4800] }, results: { shares_good: 120, shares_total: 122 }, uptime: 3600, connection: { pool: 'pool.test:3333' }, cpu: { brand: 'Ryzen', threads: 16 } } });
  const a = new XmrigAdapter(createHttpClient(new RateLimiter(100), f), 'http://127.0.0.1:8080', 'token-secreto-123456');
  const s = await a.summary();
  assert.equal(s.provenance, 'real');
  assert.equal(s.hashrateHs, 5000.5);
  assert.equal(s.sharesGood, 120);
  assert.equal(s.poolUrl, 'pool.test:3333');
  assert.equal(s.temperatureC, null);
  assert.equal(calls[0], 'http://127.0.0.1:8080/2/summary');
});

test('cgminer: lê resumo pela API TCP', async () => {
  const server = createServer((sock) => {
    sock.on('data', (d) => {
      const cmd = JSON.parse(d.toString()).command;
      const body = cmd === 'summary'
        ? { STATUS: [{}], SUMMARY: [{ 'GHS av': 110000, Accepted: 500, Rejected: 5, Elapsed: 7200 }] }
        : { VERSION: [{ BMMiner: '2.0.0' }] };
      sock.end(JSON.stringify(body) + '\0');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const s = await new CgminerAdapter(`tcp://127.0.0.1:${port}`).summary();
  server.close();
  assert.equal(s.hashrateHs, 110000 * 1e9);
  assert.equal(s.sharesGood, 500);
  assert.equal(s.sharesTotal, 505);
  assert.equal(s.version, '2.0.0');
});

test('serviço do minerador compartilha leituras (evita chamadas duplicadas)', async () => {
  let n = 0;
  const adapter = new SimulatedMinerAdapter('sha256d');
  const orig = adapter.summary.bind(adapter);
  adapter.summary = async () => { n++; return orig(); };
  const svc = new MinerService(adapter, 5000);
  await Promise.all([svc.summary(), svc.summary(), svc.summary()]);
  await svc.summary();
  assert.equal(n, 1);
});

test('Coinbase: cotação pública', async () => {
  const { f, calls } = fakeFetch({ '/v2/prices/BTC-BRL/spot': { data: { amount: '550000.12', base: 'BTC', currency: 'BRL' } } });
  const q = await new CoinbaseMarket(createHttpClient(new RateLimiter(100), f)).quote('BTC-BRL');
  assert.equal(q.price, 550000.12);
  assert.equal(q.provenance, 'real');
  assert.equal(calls[0], 'https://api.coinbase.com/v2/prices/BTC-BRL/spot');
});

test('carteira: leitura de endereço via mempool.space e validação de formato', async () => {
  const addr = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  const { f } = fakeFetch({ [`/api/address/${addr}`]: { chain_stats: { funded_txo_sum: 150000, spent_txo_sum: 50000, tx_count: 3 }, mempool_stats: { funded_txo_sum: 1000, spent_txo_sum: 0 } } });
  const http = createHttpClient(new RateLimiter(100), f);
  const w = await new MempoolWallet(http, addr).info();
  assert.equal(w.receivedSat, 150000);
  assert.equal(w.confirmedBalanceSat, 100000);
  assert.equal(w.unconfirmedSat, 1000);
  await assert.rejects(new MempoolWallet(http, 'nao-e-endereco').info(), /inválido/);
});

test('pool JSON genérica extrai campos por caminho', async () => {
  assert.equal(readPath({ a: { b: [{ c: 7 }] } }, 'a.b.0.c'), 7);
  const { f } = fakeFetch({ '/stats': { data: { unpaid: 0.0012, paid: 0.05, hr: 1.1e14 } } });
  const c = testConfig({ poolStatsUrl: 'https://pool.test/stats', poolBalancePath: 'data.unpaid', poolPaidPath: 'data.paid', poolHashratePath: 'data.hr' });
  const s = await new JsonPool(createHttpClient(new RateLimiter(100), f), c).stats();
  assert.deepEqual([s.balance, s.paidTotal, s.hashrateHs], [0.0012, 0.05, 1.1e14]);
});

test('logs mascaram segredos', () => {
  const r = redact({ apiToken: 'abc', nested: { ANTHROPIC_API_KEY: 'sk-x', ok: 1 }, authorization: 'Bearer y' }) as Record<string, any>;
  assert.equal(r.apiToken, '***');
  assert.equal(r.nested.ANTHROPIC_API_KEY, '***');
  assert.equal(r.nested.ok, 1);
  assert.equal(r.authorization, '***');
});
