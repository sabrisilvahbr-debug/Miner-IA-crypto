import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { makeApp, sleep } from './helpers.ts';
import { blockSubsidyBtc, expectedBtcPerDay, compareVersions } from '../src/agents/common.ts';
import { verifyAuditChain } from '../src/agents/d09-auditoria.ts';
import { createApiServer } from '../src/api/server.ts';

test('fórmulas determinísticas: recompensa e receita esperada', () => {
  assert.equal(blockSubsidyBtc(0), 50);
  assert.equal(blockSubsidyBtc(840_000), 3.125);
  assert.equal(blockSubsidyBtc(1_050_000), 1.5625);
  // hashrate = dificuldade·2^32/600 encontra 1 bloco a cada 10 min = 144 blocos/dia
  const d = 1e14;
  assert.ok(Math.abs(expectedBtcPerDay((d * 2 ** 32) / 600, d, 3.125) - 144 * 3.125) < 1e-6);
  assert.equal(expectedBtcPerDay(0, d, 3.125), 0);
  assert.equal(compareVersions('6.21.0', '6.22'), -1);
});

test('os 50 agentes executam em simulação sem terminar em erro', async () => {
  const app = makeApp();
  // Ordem que respeita dependências de dados (fontes antes de consumidores).
  const order = [6, 7, 8, 10, 11, 12, 13, 14, 16, 17, 21, 22, 23, 44, 42, ...Array.from({ length: 50 }, (_, i) => i + 1)];
  for (const id of order) await app.runtime.runOnce(id);
  const errors = app.runtime.agents().filter((a) => a.state === 'erro').map((a) => `${a.code}: ${a.lastError}`);
  assert.deepEqual(errors, []);
  assert.equal(app.store.latestMetric('price.BTC-USD')?.provenance, 'simulado');
  assert.equal(app.store.latestMetric('profit.revenue_day')?.provenance, 'simulado', 'estimativa derivada de simulação continua simulada');
  assert.ok(app.store.latestReport('operational'));
});

test('dados reais combinados viram estimativa, nunca "real"', async () => {
  const app = makeApp({ minerType: 'simulated' });
  const now = Date.now();
  const put = (key: string, value: number) => app.store.putMetric({ key, value, provenance: 'real', source: 't', ts: now, agentId: 1 });
  put('miner.hashrate_hs', 1e14); put('network.difficulty', 1e14); put('network.block_subsidy_btc', 3.125); put('price.BTC-BRL', 500000);
  app.store.putMetric({ key: 'miner.algo', value: 'sha256d', provenance: 'real', source: 't', ts: now, agentId: 14 });
  await app.runtime.runOnce(18);
  assert.equal(app.store.latestMetric('profit.revenue_day')?.provenance, 'estimado');
});

test('desconectado quando não há minerador configurado', async () => {
  const app = makeApp({ minerType: 'none' });
  await app.runtime.runOnce(11);
  await app.runtime.runOnce(12);
  assert.equal(app.runtime.agent(11)!.state, 'desconectado');
  assert.equal(app.runtime.agent(12)!.state, 'desconectado');
  assert.equal(app.store.latestMetric('miner.connected')?.value, false);
});

test('auditoria: cadeia de hash detecta adulteração', async () => {
  const app = makeApp();
  app.runtime.pauseSystem('teste', 'operador');
  app.runtime.resumeSystem('operador');
  await app.runtime.runOnce(41);
  assert.equal(verifyAuditChain(app.store).ok, true);
  assert.ok(verifyAuditChain(app.store).records >= 2);
  app.store.db.prepare("UPDATE audit SET payload_json = '{\"adulterado\":true}' WHERE seq = 1").run();
  assert.equal(verifyAuditChain(app.store).ok, false);
});

test('conciliação alerta quando a pool informa mais pagamento do que o recebido', async () => {
  const app = makeApp();
  const now = Date.now();
  app.store.putMetric({ key: 'pool.paid_total', value: 0.01, provenance: 'real', source: 't', ts: now, agentId: 23 });
  app.store.putMetric({ key: 'finance.confirmed_received_btc', value: 0.005, provenance: 'real', source: 't', ts: now, agentId: 42 });
  await app.runtime.runOnce(43);
  assert.ok(app.store.listAlerts().some((a) => a.code === 'finance.reconciliation'));
});

test('alertas repetidos são agrupados', () => {
  const app = makeApp();
  app.runtime.raiseAlert('x', 'warn', 'um');
  app.runtime.raiseAlert('x', 'warn', 'dois');
  const list = app.store.listAlerts();
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 2);
});

async function withServer(app: ReturnType<typeof makeApp>, fn: (base: string) => Promise<void>) {
  const server = createApiServer(app, 'web');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test('API: consultas de resumo, agentes e filtros', async () => {
  const app = makeApp();
  await app.runtime.runOnce(1);
  await withServer(app, async (base) => {
    const s = await (await fetch(`${base}/api/summary`)).json();
    assert.equal(s.collective.total, 50);
    assert.equal(s.evidence.miningActive, false);
    const dept = await (await fetch(`${base}/api/agents?department=6`)).json();
    assert.equal(dept.length, 5);
    const a = await (await fetch(`${base}/api/agents/26`)).json();
    assert.equal(a.name, 'Guardião de Risco');
    const deps = await (await fetch(`${base}/api/departments`)).json();
    assert.equal(deps.length, 10);
    assert.equal((await fetch(`${base}/api/agents/999`)).status, 404);
  });
});

test('API: pausa e retomada pelo operador', async () => {
  const app = makeApp();
  await withServer(app, async (base) => {
    await fetch(`${base}/api/system/pause`, { method: 'POST', body: JSON.stringify({ reason: 'manutenção' }) });
    assert.equal(app.guardian.pauseState().paused, true);
    const r = await fetch(`${base}/api/system/resume`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(app.guardian.pauseState().paused, false);
  });
});

test('API: com API_TOKEN, requisições sem token são recusadas', async () => {
  const app = makeApp({ apiToken: 'token-de-teste-muito-longo' });
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/summary`)).status, 401);
    assert.equal((await fetch(`${base}/api/system/pause`, { method: 'POST' })).status, 401);
    assert.equal(app.guardian.pauseState().paused, false);
    assert.equal((await fetch(`${base}/api/summary`, { headers: { authorization: 'Bearer token-de-teste-muito-longo' } })).status, 200);
  });
});

test('API: arquivos estáticos não escapam do diretório web', async () => {
  const app = makeApp();
  await withServer(app, async (base) => {
    const r = await fetch(`${base}/..%2f..%2fpackage.json`);
    const t = await r.text();
    assert.ok(!t.includes('"workspaces"') && !t.includes('ai-crypto-miner-office-50'));
  });
  await sleep(1);
});
