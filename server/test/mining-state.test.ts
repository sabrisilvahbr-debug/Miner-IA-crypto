import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { MiningStateMachine, TransitionError, buildIndicators, type MetricLike } from '../src/mining/state.ts';
import { ProcessSupervisor, sha256File } from '../src/mining/process.ts';
import { energyReport } from '../src/mining/energy.ts';
import { AUTH_PHRASE, testChecklist, validateTestRequest } from '../src/mining/testPlan.ts';
import { GpuMonitor, type GpuView } from '../src/gpu/monitor.ts';
import { createApiServer, sameOrigin } from '../src/api/server.ts';
import { makeApp } from './helpers.ts';

const NOW = 1_800_000_000_000;

// ---------------- máquina de estados ----------------

test('estado: sempre inicia DESATIVADA, mesmo que o histórico anterior termine em MINERANDO', () => {
  const prev = [{ from: 'INICIANDO' as const, to: 'MINERANDO' as const, at: NOW - 1000, origem: 'x', motivo: 'y' }];
  const m = new MiningStateMachine({ now: () => NOW, previous: prev });
  assert.equal(m.state, 'DESATIVADA');
  assert.equal(m.history().at(-1)!.origem, 'inicialização');
});

test('estado: transição não permitida é recusada e toda transição exige motivo', () => {
  const m = new MiningStateMachine({ now: () => NOW });
  assert.throws(() => m.transition('MINERANDO', 'op', 'x'), TransitionError);
  assert.throws(() => m.transition('PRONTA PARA TESTE', 'op', '  '), /motivo/);
  const t = m.transition('PRONTA PARA TESTE', 'operador', 'pré-condições conferidas');
  assert.deepEqual([t.from, t.to, t.origem, t.at], ['DESATIVADA', 'PRONTA PARA TESTE', 'operador', NOW]);
});

test('estado: MINERANDO exige processo ativo E hashrate do minerador no último minuto', () => {
  const m = new MiningStateMachine({ now: () => NOW });
  m.transition('PRONTA PARA TESTE', 'op', 'ok');
  m.transition('TESTE AUTORIZADO', 'op', 'autorizado');
  m.transition('INICIANDO', 'supervisor', 'processo iniciado');
  assert.throws(() => m.transition('MINERANDO', 's', 'x', { processAlive: false }), /processo/);
  assert.throws(() => m.transition('MINERANDO', 's', 'x', { processAlive: true }), /hashrate/);
  assert.throws(() => m.transition('MINERANDO', 's', 'x', { processAlive: true, minerHashrate: { value: 10, unit: 'H/s', at: NOW - 120_000 } }), /hashrate/);
  m.transition('MINERANDO', 'supervisor', 'hashrate reportado', { processAlive: true, minerHashrate: { value: 10, unit: 'H/s', at: NOW - 5000 } });
  assert.equal(m.state, 'MINERANDO');
});

test('estado: cada transição é registrada com origem, horário e motivo', () => {
  const seen: string[] = [];
  const m = new MiningStateMachine({ now: () => NOW, onChange: (t) => seen.push(`${t.from}>${t.to}:${t.motivo}`) });
  m.transition('DADOS INDISPONÍVEIS', 'agente 14', 'nvidia-smi ausente');
  assert.deepEqual(seen, ['DESATIVADA>DESATIVADA:o sistema sempre inicia com a mineração desativada', 'DESATIVADA>DADOS INDISPONÍVEIS:nvidia-smi ausente']);
});

// ---------------- indicadores independentes ----------------

const metricsFrom = (m: Record<string, MetricLike>) => (k: string) => m[k];

test('indicadores: sem dados, cada um mostra o próprio rótulo e nenhum valor', () => {
  const i = buildIndicators(metricsFrom({}), undefined, NOW);
  assert.equal(i.processoAtivo.estado, 'NÃO IMPLEMENTADO');
  assert.equal(i.hashrateLocal.estado, 'HASHRATE NÃO MEDIDO');
  assert.equal(i.workerConectado.estado, 'POOL NÃO CONECTADA');
  assert.equal(i.sharesAceitas.estado, 'NENHUMA SHARE ACEITA CONFIRMADA');
  assert.equal(i.saldoConfirmado.estado, 'INDISPONÍVEL');
  assert.equal(i.pagamentosConfirmados.estado, 'INDISPONÍVEL');
  for (const v of Object.values(i)) assert.equal((v as { valor?: unknown }).valor, undefined);
});

test('indicadores: GPU em uso não vira mineração, e dado simulado não vira medição', () => {
  const i = buildIndicators(metricsFrom({
    'gpu.utilization_pct': { value: 99, provenance: 'real', source: 'nvidia-smi', ts: NOW - 1000, unit: '%' },
    'miner.hashrate_hs': { value: 5e6, provenance: 'simulado', source: 'simulador', ts: NOW },
    'miner.shares_accepted': { value: 0, provenance: 'real', source: 'xmrig', ts: NOW },
  }), false, NOW);
  assert.equal(i.gpuEmUso.estado, 'REAL');
  assert.match(i.gpuEmUso.observacao!, /não comprova mineração/);
  assert.equal(i.hashrateLocal.estado, 'HASHRATE NÃO MEDIDO');
  assert.equal(i.sharesAceitas.estado, 'NENHUMA SHARE ACEITA CONFIRMADA', 'zero shares não confirma nada');
  assert.equal(i.processoAtivo.estado, 'INATIVO');
});

test('indicadores: valor real antigo aparece como DADOS DESATUALIZADOS', () => {
  const i = buildIndicators(metricsFrom({ 'gpu.utilization_pct': { value: 3, provenance: 'real', source: 'nvidia-smi', ts: NOW - 10 * 60_000 } }), undefined, NOW);
  assert.equal(i.gpuEmUso.estado, 'DADOS DESATUALIZADOS');
});

// ---------------- energia: modalidades A e B ----------------

const base = { hoursPerDay: 24, daysPerMonth: 30 };

test('energia A: custo mensal informado (R$ 110) é usado como informado, nunca como medição', () => {
  const r = energyReport({ ...base, mode: 'informado', monthlyCostInformed: 110, tariffKwh: 0.9 });
  assert.equal(r.usadoNoLucro, 'informado');
  assert.ok(Math.abs(r.custoDiario! - 110 / 30) < 1e-9);
  assert.match(r.informado.base, /informado pelo operador/);
  assert.equal(r.medido.disponivel, false);
});

test('energia A: R$ 110/mês é maior que o máximo da RTX 3050 no limite de 70 W e gera aviso', () => {
  const r = energyReport({ ...base, mode: 'comparar', monthlyCostInformed: 110, tariffKwh: 0.9, gpuPowerLimitW: 70 });
  assert.ok(r.avisos.some((a) => /maior que o máximo da GPU/.test(a) && /45\.36/.test(a)));
});

test('energia B: consumo em repouso não é aceito como consumo de mineração', () => {
  const r = energyReport({ ...base, mode: 'medido', tariffKwh: 0.9 }, { avgW: 17.2, samples: 50, duringMining: false, fromAt: 0, toAt: 1 });
  assert.equal(r.medido.disponivel, false);
  assert.match(r.medido.motivo!, /repouso/);
  assert.equal(r.custoDiario, undefined);
});

test('energia B: com medições durante mineração calcula kWh/dia × tarifa e identifica "somente GPU"', () => {
  const r = energyReport({ ...base, mode: 'medido', tariffKwh: 0.9, hoursPerDay: 12 }, { avgW: 65, samples: 40, duringMining: true, fromAt: 0, toAt: 1 });
  assert.ok(Math.abs(r.custoDiario! - (65 / 1000) * 12 * 0.9) < 1e-9);
  assert.match(r.medido.escopo, /somente GPU/);
});

test('energia: modo comparar mostra os dois e usa um só (nunca soma)', () => {
  const r = energyReport({ ...base, mode: 'comparar', monthlyCostInformed: 110, tariffKwh: 0.9 }, { avgW: 65, samples: 40, duringMining: true, fromAt: 0, toAt: 1 });
  assert.equal(r.informado.disponivel && r.medido.disponivel, true);
  assert.equal(r.usadoNoLucro, 'medido');
  assert.equal(r.custoDiario, r.medido.diario);
});

test('energia: sem nada informado nem medido, custo indisponível', () => {
  const r = energyReport({ ...base, mode: 'comparar' });
  assert.equal(r.usadoNoLucro, null);
  assert.equal(r.custoDiario, undefined);
});

// ---------------- pré-condições do teste ----------------

const okGpu: GpuView = {
  mineracao: 'DESATIVADA', hardware: 'VERIFICADO', status: 'ok', mensagem: 'ok', procedencia: 'real', coletadoEm: null, idadeSegundos: 1, consultadoEm: null, eventos: [],
  gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 3050', driverVersion: '591.86', temperatureC: 43, powerW: 17, powerLimitW: 70, utilizationPct: 0, memoryUsedMiB: 595, memoryTotalMiB: 6144, fanPct: null, pstate: 'P8', procedencia: 'real' }],
};

test('teste: validação de entrada da requisição', () => {
  assert.deepEqual(validateTestRequest({ coin: 'prl' }), { coin: 'PRL', durationMin: 5 });
  assert.match(String(validateTestRequest({ coin: 'PRL; rm -rf' })), /moeda inválida/);
  assert.match(String(validateTestRequest({ coin: 'PRL', durationMin: 120 })), /duração/);
  assert.match(String(validateTestRequest({ coin: 'PRL', durationMin: 2.5 })), /duração/);
});

test('teste: hoje nunca fica pronto — falta minerador, compatibilidade e login documentados', () => {
  const r = testChecklist({ req: { coin: 'PRL', durationMin: 5 }, gpu: okGpu, allowedPools: ['stratum+tcp://prl.2miners.com:1818'], payoutAddresses: { PRL: 'prl1qexemploenderecopublico' }, minerIntegrated: false, maxTempC: 80, criticalTempC: 90 });
  assert.equal(r.pronto, false);
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.item);
  assert.ok(failed.includes('Minerador verificado (origem, integridade e integração)'));
  assert.ok(failed.includes('Compatibilidade do algoritmo com a GPU comprovada'));
  assert.ok(r.checks.find((c) => c.item === 'GPU verificada')!.ok);
  assert.equal((r.plano.limites as { potenciaLimiteGpuW: number }).potenciaLimiteGpuW, 70);
});

test('teste: moeda em investigação e GPU ausente aparecem como falhas', () => {
  const noGpu: GpuView = { ...okGpu, status: 'nvidia_smi_ausente', hardware: 'HARDWARE NÃO VERIFICADO', gpus: null, mensagem: 'nvidia-smi não encontrado' };
  const r = testChecklist({ req: { coin: 'QTC', durationMin: 5 }, gpu: noGpu, allowedPools: [], payoutAddresses: {}, minerIntegrated: false, maxTempC: 80, criticalTempC: 90 });
  assert.equal(r.checks.find((c) => c.item === 'GPU verificada')!.ok, false);
  assert.match(r.checks.find((c) => c.item.startsWith('Moeda'))!.detalhe, /investigação/);
});

// ---------------- supervisor de processos (usa o próprio Node como processo de teste inofensivo) ----------------

const NODE = process.execPath;

test('supervisor: recusa binário fora da lista, caminho relativo e hash que não confere', async () => {
  assert.throws(() => new ProcessSupervisor([{ id: 'x', path: 'node', sha256: 'a'.repeat(64) }]), /absoluto/);
  const sup = new ProcessSupervisor([{ id: 'node', path: NODE, sha256: 'b'.repeat(64) }]);
  await assert.rejects(sup.start({ binaryId: 'outro', args: [], maxRuntimeMs: 1000 }), /lista permitida/);
  await assert.rejects(sup.start({ binaryId: 'node', args: [], maxRuntimeMs: 1000 }), /integridade recusada/);
  assert.equal(sup.isRunning(), false);
});

test('supervisor: INTERROMPER encerra o processo e confirma que ele saiu', async () => {
  const sup = new ProcessSupervisor([{ id: 'node', path: NODE, sha256: await sha256File(NODE) }]);
  await sup.start({ binaryId: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], maxRuntimeMs: 30_000 });
  assert.equal(sup.isRunning(), true);
  const rec = await sup.stop('teste de encerramento');
  assert.equal(sup.isRunning(), false);
  assert.ok(rec?.endedAt);
  assert.equal(rec?.reason, 'teste de encerramento');
});

test('supervisor: tempo máximo de segurança encerra sozinho', async () => {
  const sup = new ProcessSupervisor([{ id: 'node', path: NODE, sha256: await sha256File(NODE) }]);
  await sup.start({ binaryId: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], maxRuntimeMs: 300 });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(sup.isRunning(), false);
  assert.match(sup.last()!.reason!, /tempo máximo/);
});

test('supervisor: argumento com quebra de linha é recusado e não há segundo processo simultâneo', async () => {
  const sup = new ProcessSupervisor([{ id: 'node', path: NODE, sha256: await sha256File(NODE) }]);
  await assert.rejects(sup.start({ binaryId: 'node', args: ['-e', 'x\ny'], maxRuntimeMs: 1000 }), /argumento inválido/);
  await sup.start({ binaryId: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], maxRuntimeMs: 30_000 });
  await assert.rejects(sup.start({ binaryId: 'node', args: [], maxRuntimeMs: 1000 }), /já existe/);
  await sup.stop();
});

// ---------------- API: rotas e segurança ----------------

async function withServer(overrides: Parameters<typeof makeApp>[0], fn: (base: string) => Promise<void>, gpuMonitor?: GpuMonitor) {
  const app = makeApp(overrides, gpuMonitor ? { gpuMonitor } : {});
  const server = createApiServer(app, 'web');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try { await fn(base); } finally { await new Promise<void>((r) => server.close(() => r())); }
}

test('API: estado inicial DESATIVADA e indicadores sem valores inventados', async () => {
  await withServer({}, async (b) => {
    const s = await (await fetch(`${b}/api/mining/state`)).json();
    assert.equal(s.estado, 'DESATIVADA');
    assert.equal(s.indicadores.hashrateLocal.estado, 'HASHRATE NÃO MEDIDO');
    assert.equal(s.indicadores.processoAtivo.estado, 'NÃO IMPLEMENTADO');
  });
});

test('API: INICIAR TESTE sem pré-condições devolve 409 com a lista do que falta', async () => {
  await withServer({}, async (b) => {
    const r = await fetch(`${b}/api/mining/test/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ coin: 'PRL', durationMin: 5, confirmacao: AUTH_PHRASE }) });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.ok(j.checks.some((c: { ok: boolean }) => !c.ok));
    const s = await (await fetch(`${b}/api/mining/state`)).json();
    assert.equal(s.estado, 'DESATIVADA', 'nada foi iniciado');
  });
});

test('API: INTERROMPER sem processo ativo responde sem inventar encerramento', async () => {
  await withServer({}, async (b) => {
    const j = await (await fetch(`${b}/api/mining/stop`, { method: 'POST' })).json();
    assert.equal(j.mensagem, 'nenhum processo de mineração ativo');
  });
});

test('API: comando vindo de outra origem é recusado (403)', async () => {
  await withServer({}, async (b) => {
    const r = await fetch(`${b}/api/mining/stop`, { method: 'POST', headers: { origin: 'https://site-malicioso.example' } });
    assert.equal(r.status, 403);
  });
});

test('API: com API_TOKEN, requisição sem token é recusada (401)', async () => {
  await withServer({ apiToken: 'token-de-teste-123456' }, async (b) => {
    assert.equal((await fetch(`${b}/api/gpu`)).status, 401);
    assert.equal((await fetch(`${b}/api/gpu`, { headers: { authorization: 'Bearer token-de-teste-123456' } })).status, 200);
  });
});

test('API: /api/energy e /api/auto-mining sem fontes mostram NÃO CALCULÁVEL', async () => {
  await withServer({}, async (b) => {
    const e = await (await fetch(`${b}/api/energy`)).json();
    assert.equal(e.usadoNoLucro, null);
    const a = await (await fetch(`${b}/api/auto-mining`)).json();
    assert.equal(a.rentabilidade, 'RENTABILIDADE NÃO CALCULÁVEL — FALTA DE DADOS REAIS');
    assert.equal(a.mineracao, 'DESATIVADA');
  });
});

test('origem: mesma origem e ausência de Origin são aceitas; host diferente não', () => {
  const req = (h: Record<string, string>) => ({ headers: h }) as unknown as IncomingMessage;
  assert.equal(sameOrigin(req({ host: '127.0.0.1:8050' })), true);
  assert.equal(sameOrigin(req({ host: '127.0.0.1:8050', origin: 'http://127.0.0.1:8050' })), true);
  assert.equal(sameOrigin(req({ host: '127.0.0.1:8050', origin: 'http://evil.example' })), false);
  assert.equal(sameOrigin(req({ host: '127.0.0.1:8050', origin: 'lixo' })), false);
});

test('API: sem API_TOKEN, só o próprio computador é atendido', async () => {
  const app = makeApp();
  const handler = createApiServer(app, 'web');
  // Simula uma conexão vinda da rede local chamando o handler com um socket de outro endereço.
  const listeners = handler.listeners('request') as ((req: IncomingMessage, res: unknown) => void)[];
  const probe = createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.0.23' });
    listeners[0](req, res);
  });
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as { port: number }).port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/gpu`)).status, 401);
  } finally {
    await new Promise<void>((r) => probe.close(() => r()));
  }
});
