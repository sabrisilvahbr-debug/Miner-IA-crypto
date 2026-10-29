import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, sleep } from './helpers.ts';
import type { ActionKind, ActionProposal } from '../src/core/types.ts';
import { SimulatedMinerAdapter } from '../src/adapters/miner.ts';
import { randomUUID } from 'node:crypto';

const put = (app: ReturnType<typeof makeApp>, key: string, value: number, provenance: 'real' | 'simulado' = 'real') =>
  app.store.putMetric({ key, value, provenance, source: 'teste', ts: Date.now(), agentId: 13 });

test('R01: compras, pagamentos, saques e negociações são sempre bloqueados', () => {
  const app = makeApp();
  for (const kind of ['withdraw', 'purchase', 'payment', 'trade'] as ActionKind[]) {
    const ev = app.guardian.evaluate({ kind, params: {}, evidence: 'real' });
    assert.equal(ev.allowed, false, kind);
    assert.ok(ev.reasons.some((r) => r.startsWith('R01')));
  }
});

test('R02: tipo de ação desconhecido é bloqueado', () => {
  const app = makeApp();
  assert.equal(app.guardian.evaluate({ kind: 'formatar_disco' as ActionKind, params: {}, evidence: 'real' }).allowed, false);
});

test('R03: com o sistema pausado, só a pausa do minerador é permitida', () => {
  const app = makeApp();
  app.guardian.pause('teste', 'operador');
  assert.equal(app.guardian.evaluate({ kind: 'resume_miner', params: {}, evidence: 'real' }).allowed, false);
  assert.equal(app.guardian.evaluate({ kind: 'pause_miner', params: {}, evidence: 'real' }).allowed, true);
});

test('R04: dados simulados não autorizam ação sobre minerador real', () => {
  const app = makeApp();
  app.guardian.minerProvenance = 'real';
  assert.equal(app.guardian.evaluate({ kind: 'restart_miner', params: {}, evidence: 'simulado' }).allowed, false);
  assert.equal(app.guardian.evaluate({ kind: 'restart_miner', params: {}, evidence: 'real' }).allowed, true);
});

test('R05: limite de reinícios por hora', () => {
  const app = makeApp({ maxRestartsPerHour: 2 });
  for (let i = 0; i < 2; i++) {
    const a: ActionProposal = { id: randomUUID(), ts: Date.now(), kind: 'restart_miner', params: {}, reason: 't', proposedBy: 15, evidence: 'real', status: 'executada', guardianReasons: [] };
    app.store.saveAction(a);
  }
  const ev = app.guardian.evaluate({ kind: 'restart_miner', params: {}, evidence: 'real' });
  assert.equal(ev.allowed, false);
  assert.ok(ev.reasons.some((r) => r.startsWith('R05')));
});

test('R07: troca de pool somente para pool permitida', () => {
  const app = makeApp({ allowedPools: ['stratum+tcp://boa:3333'] });
  assert.equal(app.guardian.evaluate({ kind: 'switch_pool', params: { pool: 'stratum+tcp://estranha:3333' }, evidence: 'real' }).allowed, false);
  assert.equal(app.guardian.evaluate({ kind: 'switch_pool', params: { pool: 'stratum+tcp://boa:3333' }, evidence: 'real' }).allowed, true);
});

test('R08: não retoma mineração com temperatura acima do limite', () => {
  const app = makeApp({ maxTempC: 80 });
  put(app, 'miner.temperature_c', 82);
  assert.equal(app.guardian.evaluate({ kind: 'resume_miner', params: {}, evidence: 'real' }).allowed, false);
});

test('S01: temperatura crítica pausa o sistema e impede retomada', () => {
  const app = makeApp({ criticalTempC: 90 });
  put(app, 'miner.temperature_c', 93);
  const s = app.guardian.checkState();
  assert.equal(s.level, 'critico');
  assert.equal(app.guardian.pauseState().paused, true);
  assert.equal(app.runtime.resumeSystem('operador').ok, false);
  put(app, 'miner.temperature_c', 70);
  assert.equal(app.runtime.resumeSystem('operador').ok, true);
});

test('fluxo completo: proposta → operador aprova → Guardião reavalia → executor pausa o minerador simulado', async () => {
  const miner = new SimulatedMinerAdapter('sha256d');
  const app = makeApp({}, { minerAdapter: miner });
  app.runtime.wireTriggersOnly();
  const a = app.runtime.proposeAction({ kind: 'pause_miner', params: {}, reason: 'teste', evidence: 'simulado' }, 31);
  assert.equal(a.status, 'pendente_operador');
  assert.equal(miner.paused, false, 'nada é executado sem aprovação');
  const d = app.runtime.decideAction(a.id, 'approve', 'operador');
  assert.equal(d.ok, true);
  await sleep(50);
  assert.equal(app.store.getAction(a.id)?.status, 'executada');
  assert.equal(miner.paused, true);
});

test('ação financeira inserida como aprovada nunca é executada', async () => {
  const app = makeApp();
  app.runtime.wireTriggersOnly();
  const a: ActionProposal = { id: randomUUID(), ts: Date.now(), kind: 'withdraw', params: { amount: 1 }, reason: 'forçado', proposedBy: 99, evidence: 'real', status: 'aprovada_operador', guardianReasons: [] };
  app.store.saveAction(a);
  app.bus.publish({ type: 'action.approved', severity: 'info', message: 'x', data: { actionId: a.id, dedupeKey: a.id } });
  await sleep(50);
  const after = app.store.getAction(a.id)!;
  assert.equal(after.status, 'bloqueada');
  assert.ok(after.guardianReasons.some((r) => r.startsWith('R01')));
});

test('proposta proibida já nasce bloqueada e o operador não pode aprová-la', () => {
  const app = makeApp();
  const a = app.runtime.proposeAction({ kind: 'payment', params: {}, reason: 'x', evidence: 'real' }, 31);
  assert.equal(a.status, 'bloqueada');
  assert.equal(app.runtime.decideAction(a.id, 'approve', 'operador').ok, false);
});
