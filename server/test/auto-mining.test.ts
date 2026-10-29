import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, findCoin } from '../src/mining/catalog.ts';
import { daysToPayout, energyCostDay, netDay, isFresh, type MarketQuote } from '../src/mining/profitability.ts';
import { DEFAULT_SELECTOR, activeCandidates, decide, evaluate, type SelectorConfig } from '../src/mining/selector.ts';
import { runSimulation, autoMiningSnapshot, MODE_LABEL, REEVALUATE_EVERY_MS } from '../src/mining/simulation.ts';

const NOW = 1_000_000_000_000;
const cfg: SelectorConfig = { ...DEFAULT_SELECTOR, energy: { powerW: 170, powerIsMeasured: false, tariffKwh: 0.9 } };
const q = (symbol: string, revenueLocalDay: number, coinsPerDay = 1, ageMs = 60_000): MarketQuote => ({
  symbol, revenueLocalDay, coinsPerDay, collectedAt: NOW - ageMs, source: 'teste',
});

test('catálogo: só PRL e QTC são avaliadas; EPIC e XTM ficam em investigação', () => {
  assert.deepEqual(activeCandidates().map((c) => c.symbol).sort(), ['PRL', 'QTC']);
  assert.equal(findCoin('epic')?.status, 'investigar');
  assert.equal(findCoin('XTM')?.status, 'investigar');
  assert.equal(findCoin('XTM')?.pool, undefined, 'investigação não tem pool inventada');
  assert.equal(findCoin('RVN'), undefined, 'Ravencoin não está no catálogo');
});

test('catálogo: dados de pool conferem com a página da 2Miners', () => {
  const prl = findCoin('PRL')!.pool!;
  assert.equal(prl.stratumUrl, 'stratum+tcp://prl.2miners.com:1818');
  assert.equal(prl.poolFee, 0.01);
  assert.equal(prl.minPayout, 1);
  const qtc = findCoin('QTC')!.pool!;
  assert.equal(qtc.stratumUrl, 'stratum+tcp://qtc.2miners.com:3636');
  assert.equal(qtc.minPayout, 0.1);
  for (const c of CATALOG.filter((x) => x.pool)) assert.match(c.pool!.sourceUrl, /^https:\/\/2miners\.com\//);
});

test('energia: 170 W a R$ 0,90/kWh, 24 h, dá R$ 3,672/dia', () => {
  assert.ok(Math.abs(energyCostDay(170, 0.9) - 3.672) < 1e-9);
});

test('energia: 120 W a R$ 0,90/kWh por 30 dias dá cerca de R$ 77,76/mês (antes de impostos)', () => {
  assert.ok(Math.abs(energyCostDay(120, 0.9) * 30 - 77.76) < 1e-9);
});

test('lucro líquido: receita − taxa da pool − energia', () => {
  const r = netDay(100, 0.01, { powerW: 170, powerIsMeasured: false, tariffKwh: 0.9 });
  assert.ok(Math.abs(r.netDay - (100 - 1 - 3.672)) < 1e-9);
});

test('pagamento: sem produção, tempo infinito; com produção, leva em conta a taxa', () => {
  assert.equal(daysToPayout(0, 0.01, 1), Number.POSITIVE_INFINITY);
  assert.ok(Math.abs(daysToPayout(10, 0.01, 99) - 10) < 1e-9);
});

test('frescor: dado com mais de 15 minutos não é fresco', () => {
  assert.equal(isFresh(NOW - 14 * 60_000, NOW), true);
  assert.equal(isFresh(NOW - 16 * 60_000, NOW), false);
});

test('avaliação: sem dado, dado antigo ou moeda em investigação não são elegíveis', () => {
  const prl = findCoin('PRL')!;
  assert.equal(evaluate(prl, undefined, cfg, NOW).eligible, false);
  assert.equal(evaluate(prl, q('PRL', 50, 1, 20 * 60_000), cfg, NOW).eligible, false);
  assert.equal(evaluate(findCoin('EPIC')!, q('EPIC', 50), cfg, NOW).eligible, false);
  const ok = evaluate(prl, q('PRL', 50), cfg, NOW);
  assert.equal(ok.eligible, true);
  assert.ok(ok.net && ok.net.netDay > 0);
});

test('decisão: sem dados atuais aguarda, não troca', () => {
  const evals = activeCandidates().map((c) => evaluate(c, undefined, cfg, NOW));
  assert.equal(decide({ evaluations: evals, now: NOW, cfg }).action, 'aguardar_dados');
});

test('decisão: todas as alternativas negativas suspendem', () => {
  const evals = activeCandidates().map((c) => evaluate(c, q(c.symbol, 1), cfg, NOW)); // receita 1 < energia 3,67
  assert.equal(decide({ evaluations: evals, current: 'PRL', now: NOW, cfg }).action, 'suspender');
});

test('decisão: sem moeda atual, escolhe a melhor', () => {
  const evals = [evaluate(findCoin('PRL')!, q('PRL', 40), cfg, NOW), evaluate(findCoin('QTC')!, q('QTC', 60), cfg, NOW)];
  const d = decide({ evaluations: evals, now: NOW, cfg });
  assert.equal(d.action, 'trocar');
  assert.equal(d.target, 'QTC');
});

test('decisão: diferença pequena não justifica troca (proteção contra oscilação)', () => {
  const evals = [evaluate(findCoin('PRL')!, q('PRL', 50), cfg, NOW), evaluate(findCoin('QTC')!, q('QTC', 50.5), cfg, NOW)];
  const d = decide({ evaluations: evals, current: 'PRL', now: NOW, cfg });
  assert.equal(d.action, 'manter');
});

test('decisão: ganho grande troca, mas respeita o intervalo mínimo entre trocas', () => {
  const evals = [evaluate(findCoin('PRL')!, q('PRL', 40), cfg, NOW), evaluate(findCoin('QTC')!, q('QTC', 80), cfg, NOW)];
  assert.equal(decide({ evaluations: evals, current: 'PRL', now: NOW, cfg }).action, 'trocar');
  const recente = decide({ evaluations: evals, current: 'PRL', lastSwitchAt: NOW - 5 * 60_000, now: NOW, cfg });
  assert.equal(recente.action, 'manter');
});

test('decisão: não troca no escuro quando a moeda atual não tem dado', () => {
  const evals = [evaluate(findCoin('PRL')!, undefined, cfg, NOW), evaluate(findCoin('QTC')!, q('QTC', 80), cfg, NOW)];
  const d = decide({ evaluations: evals, current: 'PRL', now: NOW, cfg });
  assert.equal(d.action, 'manter');
});

test('simulação: fonte de mercado falhando não gera trocas e registra aguardar_dados', () => {
  const steps = [0, 1, 2].map((i) => ({ now: NOW + i * REEVALUATE_EVERY_MS, quotes: [] }));
  const r = runSimulation(steps, cfg, 'PRL');
  assert.equal(r.modo, MODE_LABEL);
  assert.equal(r.switches, 0);
  assert.ok(r.records.every((x) => x.decision.action === 'aguardar_dados'));
  assert.equal(r.finalCurrent, 'PRL');
});

test('simulação: cenário com queda da PRL troca para a QTC e conta a troca', () => {
  const steps = [
    { now: NOW, quotes: [q('PRL', 60), q('QTC', 40)] },
    { now: NOW + REEVALUATE_EVERY_MS, quotes: [q('PRL', 30), q('QTC', 90)] },
  ];
  const r = runSimulation(steps, cfg, 'PRL');
  assert.equal(r.switches, 1);
  assert.equal(r.finalCurrent, 'QTC');
});

test('simulação: nunca usa moeda fora do catálogo validado', () => {
  const r = runSimulation([{ now: NOW, quotes: [q('EPIC', 999), q('XTM', 999)] }], cfg);
  assert.equal(r.records[0].decision.action, 'aguardar_dados');
});

test('painel: sem fonte de mercado, mostra indisponível e aviso de simulação', () => {
  const snap = autoMiningSnapshot(cfg, [], NOW);
  assert.equal(snap.modo, 'SIMULAÇÃO');
  assert.match(snap.fonteMercado, /indisponível/);
  assert.equal(snap.decisao.action, 'aguardar_dados');
  assert.match(snap.avisoOperacao, /nenhum minerador é iniciado/);
});
