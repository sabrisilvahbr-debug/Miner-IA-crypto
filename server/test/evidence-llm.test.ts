import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEvidence } from '../src/core/evidence.ts';
import type { Metric, Provenance } from '../src/core/types.ts';
import { validateAnalysis } from '../src/core/llmGateway.ts';
import { makeApp } from './helpers.ts';

function metrics(entries: Record<string, unknown>, provenance: Provenance = 'real') {
  const now = Date.now();
  const map = new Map<string, Metric>();
  for (const [key, value] of Object.entries(entries)) map.set(key, { key, value: value as Metric['value'], provenance, source: 't', ts: now, agentId: 1 });
  return (k: string) => map.get(k);
}

test('evidência: sem dados → nível 0, mineração não confirmada', () => {
  const e = computeEvidence(metrics({}), Date.now());
  assert.equal(e.level, 0);
  assert.equal(e.miningActive, false);
});

test('evidência: conexão e hashrate sem shares não declaram mineração ativa', () => {
  const e = computeEvidence(metrics({ 'miner.connected': true, 'miner.hashrate_hs': 1e12, 'miner.shares_accepted_delta': 0 }), Date.now());
  assert.equal(e.level, 2);
  assert.equal(e.miningActive, false);
});

test('evidência: shares aceitas reais declaram mineração ativa', () => {
  const e = computeEvidence(metrics({ 'miner.connected': true, 'miner.hashrate_hs': 1e12, 'miner.shares_accepted_delta': 4, 'miner.shares_accepted': 100 }), Date.now());
  assert.equal(e.level, 3);
  assert.equal(e.miningActive, true);
});

test('evidência: dados simulados nunca declaram mineração ativa', () => {
  const e = computeEvidence(metrics({ 'miner.connected': true, 'miner.hashrate_hs': 1e12, 'miner.shares_accepted_delta': 4, 'pool.balance': 0.1, 'finance.confirmed_received_btc': 0.2 }, 'simulado'), Date.now());
  assert.equal(e.level, 5);
  assert.equal(e.simulated, true);
  assert.equal(e.miningActive, false);
  assert.match(e.statement, /SIMULAÇÃO/);
});

test('evidência: leituras antigas não contam', () => {
  const old = new Map<string, Metric>([['miner.connected', { key: 'miner.connected', value: true, provenance: 'real', source: 't', ts: Date.now() - 3_600_000, agentId: 1 }]]);
  assert.equal(computeEvidence((k) => old.get(k), Date.now()).level, 0);
});

test('LLM desligado por padrão', () => {
  const app = makeApp();
  const s = app.llm.status();
  assert.equal(s.enabled, false);
  assert.match(s.reason!, /desativado/);
});

test('LLM respeita limite diário de chamadas', async () => {
  let calls = 0;
  const app = makeApp({ llmEnabled: true, anthropicApiKey: 'k'.repeat(20), llmMaxCallsPerDay: 2 }, {
    llmTransport: async () => { calls++; return { text: '{}', inputTokens: 10, outputTokens: 5 }; },
  });
  for (let i = 0; i < 4; i++) await app.llm.complete({ agentId: 34, purpose: 't', system: 's', prompt: 'p' });
  assert.equal(calls, 2);
  assert.equal(app.llm.status().enabled, false);
});

test('validação rejeita promessas de lucro e números inventados', () => {
  assert.equal(validateAnalysis('{"resumo":"Lucro garantido!","riscos":[]}', []).ok, false);
  assert.equal(validateAnalysis('{"resumo":"Receita de 12345 por dia","riscos":[]}', [500]).ok, false);
  assert.equal(validateAnalysis('{"resumo":"Receita estimada de 500 por dia","riscos":["temperatura"]}', [500]).ok, true);
  assert.equal(validateAnalysis('texto sem json', []).ok, false);
});

test('Redator usa texto determinístico quando a saída do LLM é inválida', async () => {
  const app = makeApp({ llmEnabled: true, anthropicApiKey: 'k'.repeat(20) }, {
    llmTransport: async () => ({ text: '{"resumo":"retorno garantido de 999999","riscos":[]}', inputTokens: 10, outputTokens: 5 }),
  });
  await app.runtime.runOnce(34);
  const r = app.store.latestReport('analysis')!.body as { fonte: string; observacao: string };
  assert.equal(r.fonte, 'determinístico');
  assert.match(r.observacao, /rejeitada/);
});
