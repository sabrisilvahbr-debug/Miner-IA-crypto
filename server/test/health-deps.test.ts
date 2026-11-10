import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { makeApp, fakeAgent } from './helpers.ts';
import { ALL_AGENTS, DEPENDS_ON, topologicalOrder, validateDependencies } from '../src/agents/index.ts';
import { createApiServer } from '../src/api/server.ts';

test('dependências: os 50 agentes formam um grafo válido e sem ciclos', () => {
  assert.equal(ALL_AGENTS.length, 50);
  assert.deepEqual(validateDependencies(ALL_AGENTS), []);
  for (const a of ALL_AGENTS) assert.deepEqual(a.dependsOn, DEPENDS_ON[a.id] ?? [], `${a.code} com dependsOn do mapa central`);
  const order = topologicalOrder(ALL_AGENTS);
  assert.equal(new Set(order).size, 50);
  for (const a of ALL_AGENTS) for (const d of a.dependsOn ?? []) assert.ok(order.indexOf(d) < order.indexOf(a.id), `${d} vem antes de ${a.id}`);
});

test('dependências: detecta referência inexistente, autodependência e ciclo', () => {
  const mk = (id: number, dependsOn: number[]) => ({ id, code: `T${id}`, dependsOn });
  assert.match(validateDependencies([mk(1, [9])]).join(), /inexistente 9/);
  assert.match(validateDependencies([mk(1, [1])]).join(), /si mesmo/);
  assert.match(validateDependencies([mk(1, [2]), mk(2, [3]), mk(3, [1])]).join(), /ciclo/);
  assert.match(validateDependencies([mk(1, [2, 2]), mk(2, [])]).join(), /repetida/);
});

test('saúde: nunca executou = indeterminado; após sucesso = ok', async () => {
  const app = makeApp();
  assert.equal(app.runtime.healthOf(17)!.level, 'indeterminado');
  assert.equal(app.runtime.healthOf(8)!.level, 'ok', 'agente por evento sem evento não é problema');
  await app.runtime.runOnce(17);
  const h = app.runtime.healthOf(17)!;
  assert.equal(h.level, 'ok');
  assert.equal(h.ok, true);
  assert.equal(app.runtime.healthOf(999), undefined);
  assert.equal(app.runtime.healthAll().length, 50);
});

test('saúde: falha do agente vira "falha" e o dependente passa a "atenção"', async () => {
  const app = makeApp({ maxRetries: 0 }, {
    agents: [
      fakeAgent(1, async () => { throw new Error('quebrou'); }),
      fakeAgent(2, async () => ({ status: 'ok', summary: 'ok' }), { dependsOn: [1] }),
    ],
  });
  await app.runtime.runOnce(1);
  await app.runtime.runOnce(2);
  const h1 = app.runtime.healthOf(1)!;
  assert.equal(h1.level, 'falha');
  assert.match(h1.detail, /quebrou/);
  const h2 = app.runtime.healthOf(2)!;
  assert.equal(h2.level, 'atencao');
  assert.match(h2.detail, /T1 \(erro\)/);
});

test('saúde: fonte desconectada é atenção, não falha', async () => {
  const app = makeApp({ minerType: 'none' });
  await app.runtime.runOnce(11);
  const h = app.runtime.healthOf(11)!;
  assert.equal(h.level, 'atencao');
  assert.ok(h.checks.some((c) => c.name === 'fonte'));
});

test('saúde: sem batimento além de 3 intervalos é falha', async () => {
  let now = 1_000_000;
  const app = makeApp({}, { now: () => now, agents: [fakeAgent(1, async () => ({ status: 'ok', summary: 'ok' }), { intervalMs: 10_000 })] });
  app.runtime.start();
  await app.runtime.runOnce(1);
  assert.equal(app.runtime.healthOf(1)!.level, 'ok');
  now += 10_000 * 3 + 61_000;
  assert.equal(app.runtime.healthOf(1)!.level, 'falha');
  app.runtime.stop();
});

test('saúde: verificação própria do agente entra no resultado', async () => {
  const app = makeApp({}, {
    agents: [
      fakeAgent(1, async () => ({ status: 'ok', summary: 'ok' }), { health: async () => ({ ok: false, detail: 'sensor travado' }) }),
      fakeAgent(2, async () => ({ status: 'ok', summary: 'ok' }), { health: async () => { throw new Error('explodiu'); } }),
    ],
  });
  await app.runtime.runOnce(1);
  await app.runtime.runOnce(2);
  const h1 = (await app.runtime.checkHealth(1))!;
  assert.equal(h1.level, 'falha');
  assert.match(h1.detail, /sensor travado/);
  assert.match((await app.runtime.checkHealth(2))!.detail, /explodiu/);
});

test('saúde: Guardião e Gateway de LLM têm verificação própria', async () => {
  const app = makeApp();
  await app.runtime.runOnce(26);
  const g = (await app.runtime.checkHealth(26))!;
  assert.ok(g.checks.some((c) => c.name === 'proprio' && c.level === 'ok' && /regras/.test(c.detail)));
  const l = (await app.runtime.checkHealth(33))!;
  assert.ok(l.checks.some((c) => c.name === 'proprio' && /desligado/.test(c.detail)));
});

test('A03 valida o mapa de dependências e A04 publica os níveis de saúde', async () => {
  const app = makeApp();
  await app.runtime.runOnce(3);
  assert.equal(app.store.latestMetric('registry.valid')?.value, true);
  assert.ok(Number(app.store.latestMetric('registry.dependencies')?.value) > 30);
  await app.runtime.runOnce(4);
  const sum = ['ok', 'attention', 'failed'].reduce((n, k) => n + Number(app.store.latestMetric(`health.${k}_agents`)?.value), 0);
  assert.ok(sum <= 50 && sum >= 1);
});

test('API: saúde coletiva, ficha com saúde e dependências, mapa de dependências', async () => {
  const app = makeApp();
  const server = createApiServer(app, 'web');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await app.runtime.runOnce(18);
    const health = await (await fetch(`${base}/api/agents-health`)).json() as any;
    assert.equal(health.total, 50);
    assert.equal(health.byLevel.ok + health.byLevel.atencao + health.byLevel.falha + health.byLevel.indeterminado, 50);
    const a18 = await (await fetch(`${base}/api/agents/18`)).json() as any;
    assert.ok(a18.health.checks.length >= 2);
    assert.deepEqual(a18.dependencies.map((d: any) => d.id), [6, 7, 8, 12, 16, 17]);
    assert.ok(a18.dependents.some((d: any) => d.id === 19));
    const deps = await (await fetch(`${base}/api/dependencies`)).json() as any;
    assert.equal(deps.nodes.length, 50);
    assert.deepEqual(deps.problems, []);
    assert.ok(deps.edges.some((e: any) => e.from === 26 && e.to === 37));
    const list = await (await fetch(`${base}/api/agents`)).json() as any[];
    assert.ok(list.every((a) => typeof a.healthLevel === 'string' && Array.isArray(a.dependsOn)));
  } finally {
    server.close();
  }
});
