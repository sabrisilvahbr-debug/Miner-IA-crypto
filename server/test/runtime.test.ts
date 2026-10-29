import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, fakeAgent, sleep } from './helpers.ts';
import { ALL_AGENTS, DEPARTMENTS } from '../src/agents/index.ts';
import { DisconnectedError } from '../src/core/rateLimiter.ts';

test('registro central: 50 agentes, 5 por departamento, contratos completos', () => {
  assert.equal(ALL_AGENTS.length, 50);
  assert.deepEqual(ALL_AGENTS.map((a) => a.id), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(new Set(ALL_AGENTS.map((a) => a.code)).size, 50);
  for (const d of DEPARTMENTS) assert.equal(ALL_AGENTS.filter((a) => a.department === d.id).length, 5, `departamento ${d.id}`);
  for (const a of ALL_AGENTS) {
    assert.equal(a.department, Math.ceil(a.id / 5), `${a.code} no departamento correto`);
    assert.ok(a.responsibility && a.inputs.length && a.outputs.length && a.permissions.length, `${a.code} com contrato completo`);
    if (a.mode !== 'event') assert.ok(a.intervalMs, `${a.code} com intervalo`);
    else assert.ok(a.triggers?.length, `${a.code} com gatilhos`);
  }
});

test('registro rejeita ids ou códigos duplicados', () => {
  const run = async () => ({ status: 'ok' as const, summary: '' });
  assert.throws(() => makeApp({}, { agents: [fakeAgent(1, run), fakeAgent(1, run, { code: 'X' })] }), /duplicado/);
  assert.throws(() => makeApp({}, { agents: [fakeAgent(1, run), fakeAgent(2, run, { code: 'T1' })] }), /duplicado/);
});

test('consulta individual e coletiva do estado', async () => {
  const app = makeApp();
  const sum = app.runtime.collectiveSummary();
  assert.equal(sum.total, 50);
  assert.equal(sum.byState.ocioso, 50);
  assert.equal(app.runtime.agent(26)?.name, 'Guardião de Risco');
});

test('evita tarefas duplicadas com a mesma chave', async () => {
  const app = makeApp({}, { agents: [fakeAgent(1, async () => { await sleep(30); return { status: 'ok', summary: 'ok' }; })] });
  const a = app.runtime.enqueue(1, 'teste');
  const b = app.runtime.enqueue(1, 'teste');
  assert.equal(a.accepted, true);
  assert.equal(b.accepted, false);
  assert.equal(b.duplicate, true);
  await a.done;
  assert.equal(app.runtime.agent(1)?.duplicatesSkipped, 1);
  const c = app.runtime.enqueue(1, 'teste');
  assert.equal(c.accepted, true, 'após terminar, nova tarefa é aceita');
  await c.done;
});

test('respeita o limite de concorrência', async () => {
  let current = 0;
  let peak = 0;
  const run = async () => { current++; peak = Math.max(peak, current); await sleep(20); current--; return { status: 'ok' as const, summary: 'ok' }; };
  const agents = Array.from({ length: 8 }, (_, i) => fakeAgent(i + 1, run));
  const app = makeApp({ maxConcurrency: 3 }, { agents });
  await Promise.all(agents.map((a) => app.runtime.enqueue(a.id, 'x').done));
  assert.equal(peak, 3);
});

test('repete após falha e registra a última execução bem-sucedida', async () => {
  let calls = 0;
  const app = makeApp({ maxRetries: 2 }, { agents: [fakeAgent(1, async () => { calls++; if (calls < 3) throw new Error('falha temporária'); return { status: 'ok', summary: 'recuperado' }; })] });
  const t = await app.runtime.enqueue(1, 'x').done;
  assert.equal(t?.attempts, 3);
  assert.equal(t?.status, 'done');
  const info = app.runtime.agent(1)!;
  assert.equal(info.state, 'operacional');
  assert.ok(info.lastSuccessAt);
  assert.equal(app.store.listExecutions(1).length, 3);
});

test('falha definitiva leva ao estado erro e publica agent.error', async () => {
  const app = makeApp({ maxRetries: 1 }, { agents: [fakeAgent(1, async () => { throw new Error('quebrou'); })] });
  const events: string[] = [];
  app.bus.subscribe('agent.error', (e) => events.push(e.message));
  const t = await app.runtime.enqueue(1, 'x').done;
  assert.equal(t?.status, 'failed');
  const info = app.runtime.agent(1)!;
  assert.equal(info.state, 'erro');
  assert.equal(info.lastError, 'quebrou');
  assert.equal(info.consecutiveFailures, 1);
  assert.equal(events.length, 1);
});

test('tempo limite interrompe execuções lentas', async () => {
  const app = makeApp({ taskTimeoutMs: 30, maxRetries: 0 }, { agents: [fakeAgent(1, async () => { await sleep(200); return { status: 'ok', summary: '' }; })] });
  await app.runtime.enqueue(1, 'x').done;
  assert.match(app.runtime.agent(1)!.lastError!, /tempo limite/);
});

test('falha de conexão leva ao estado desconectado sem novas tentativas', async () => {
  let calls = 0;
  const app = makeApp({ maxRetries: 3 }, { agents: [fakeAgent(1, async () => { calls++; throw new DisconnectedError('sem resposta'); })] });
  await app.runtime.enqueue(1, 'x').done;
  assert.equal(calls, 1);
  assert.equal(app.runtime.agent(1)!.state, 'desconectado');
});

test('permissões são verificadas: escrever métrica sem write:metrics é erro', async () => {
  const app = makeApp({}, { agents: [fakeAgent(1, async () => ({ status: 'ok', summary: '', metrics: [{ key: 'x', value: 1, provenance: 'real', source: 't' }] }), { permissions: ['emit:alert'] })] });
  await app.runtime.enqueue(1, 'x').done;
  assert.equal(app.runtime.agent(1)!.state, 'erro');
  assert.match(app.runtime.agent(1)!.lastError!, /write:metrics/);
});

test('permissões são verificadas: acessar minerador sem read:miner é erro', async () => {
  const app = makeApp({}, { agents: [fakeAgent(1, async (ctx) => { await ctx.services.miner.summary(); return { status: 'ok', summary: '' }; })] });
  await app.runtime.enqueue(1, 'x').done;
  assert.match(app.runtime.agent(1)!.lastError!, /read:miner/);
});

test('métrica sem procedência é rejeitada', async () => {
  const app = makeApp({}, { agents: [fakeAgent(1, async () => ({ status: 'ok', summary: '', metrics: [{ key: 'x', value: 1, source: 't' } as never] }))] });
  await app.runtime.enqueue(1, 'x').done;
  assert.match(app.runtime.agent(1)!.lastError!, /procedência/);
});

test('pausa do Guardião bloqueia agentes não essenciais e mantém os essenciais', async () => {
  const ok = async () => ({ status: 'ok' as const, summary: 'ok' });
  const app = makeApp({}, { agents: [fakeAgent(1, ok), fakeAgent(2, ok, { essential: true })] });
  app.runtime.pauseSystem('teste', 'operador');
  await app.runtime.enqueue(1, 'x').done;
  await app.runtime.enqueue(2, 'x').done;
  assert.equal(app.runtime.agent(1)!.state, 'bloqueado');
  assert.equal(app.runtime.agent(2)!.state, 'operacional');
  const r = app.runtime.resumeSystem('operador');
  assert.equal(r.ok, true);
  await app.runtime.enqueue(1, 'x').done;
  assert.equal(app.runtime.agent(1)!.state, 'operacional');
});

test('agentes acionados por evento e sem auto-acionamento', async () => {
  let runs = 0;
  const app = makeApp({}, {
    agents: [fakeAgent(1, async (ctx) => { runs++; ctx.emit({ type: 'teste.ping', severity: 'info', message: 'x' }); return { status: 'ok', summary: '' }; }, { mode: 'event', intervalMs: undefined, triggers: ['teste.*'] })],
  });
  app.runtime.wireTriggersOnly();
  app.bus.publish({ type: 'teste.inicio', severity: 'info', message: 'inicio' });
  await sleep(30);
  assert.equal(runs, 1, 'executa uma vez e não reage ao próprio evento');
});
