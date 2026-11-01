// Integração com o SRBMiner-MULTI. Nenhum teste executa um minerador de verdade: o "minerador" é
// test/fixtures/fake-srbminer.mjs, que só imprime linhas no formato do console.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSrbArgs, SrbConsoleParser } from '../src/mining/srbminer.ts';
import { findCoin } from '../src/mining/catalog.ts';
import { MiningTestRunner, type TestReport } from '../src/mining/testRunner.ts';
import { MiningStateMachine } from '../src/mining/state.ts';
import { ProcessSupervisor, sha256File } from '../src/mining/process.ts';
import { minerGpuConfig } from '../src/config.ts';
import { GpuMonitor, type GpuView } from '../src/gpu/monitor.ts';
import { createApiServer } from '../src/api/server.ts';
import { AUTH_PHRASE } from '../src/mining/testPlan.ts';
import { makeApp, sleep } from './helpers.ts';
import type { Metric } from '../src/core/types.ts';

const FAKE = resolve('server/test/fixtures/fake-srbminer.mjs');
chmodSync(FAKE, 0o755);
const PROFILE = findCoin('PRL')!.minerProfile!;
const ADDR = 'prl1qexemploenderecopublico0000';
const KRYPTEX = 'stratum+tcp://prl-br.kryptex.network:7048';
// O minerador falso é um script com shebang: no Windows ele não é executável sem shell (e o supervisor nunca usa shell).
const POSIX = { skip: process.platform === 'win32' ? 'minerador falso só roda em Linux/macOS' : false };

// ---------------- argumentos ----------------

test('srbminer: argumentos são exatamente os publicados (Kryptex + Parameters), sem API nem desligamento', () => {
  const a = buildSrbArgs({ profile: PROFILE, wallet: ADDR, worker: 'rtx3050', gpuOffTempC: 80 });
  assert.deepEqual(a, [
    '--disable-cpu', '--disable-gpu-amd', '--disable-gpu-intel',
    '--algorithm', 'pearlhash', '--pool', 'prl-br.kryptex.network:7048',
    '--wallet', `${ADDR}.rtx3050`, '--gpu-off-temperature', '80',
  ]);
  assert.ok(!a.some((x) => /api|shutdown|restart/.test(x)));
});

test('srbminer: recusa endereço, worker e temperatura inválidos', () => {
  const base = { profile: PROFILE, wallet: ADDR, worker: 'rtx3050', gpuOffTempC: 80 };
  assert.throws(() => buildSrbArgs({ ...base, wallet: 'abandon ability able about above absent absorb' }), /endereço/);
  assert.throws(() => buildSrbArgs({ ...base, wallet: `${ADDR} --api-enable` }), /endereço/);
  assert.throws(() => buildSrbArgs({ ...base, worker: 'a b' }), /worker/);
  assert.throws(() => buildSrbArgs({ ...base, gpuOffTempC: 99 }), /temperatura/);
  assert.throws(() => buildSrbArgs({ ...base, profile: { ...PROFILE, poolHostPort: 'evil.example.com:1; rm' } }), /pool/);
});

// ---------------- leitura do console ----------------

test('console: remove cores, conta shares, lê "Total:" com vírgula e unidade, junta linhas quebradas', () => {
  const p = new SrbConsoleParser(() => 1000);
  p.feed('\u001b[32mGPU0 result accepted\u001b[0m\nGPU0 result rej');
  p.feed('ected\npool: new job received\n[09:00] Total: 25,10 TH/s\n');
  assert.equal(p.stats.accepted, 1);
  assert.equal(p.stats.rejected, 1);
  assert.equal(p.stats.jobs, 1);
  assert.equal(p.stats.hashrateHs, 25.1e12);
  assert.equal(p.stats.hashrateRaw, 'Total: 25,10 TH/s');
  assert.equal(p.lastLines(1)[0], '[09:00] Total: 25,10 TH/s');
});

test('console: "Total:" em formato desconhecido é ignorado e contado, nunca adivinhado', () => {
  const p = new SrbConsoleParser();
  p.feed('Total: muito rápido\nTotal shares: 10\n');
  assert.equal(p.stats.hashrateHs, undefined);
  assert.equal(p.stats.unmatchedTotalLines, 1, '"Total shares:" não é linha de hashrate e não conta');
});

// ---------------- configuração ----------------

test('config: MINER_GPU_PATH e MINER_GPU_SHA256 inválidos são recusados com motivo', () => {
  const ok = minerGpuConfig({ MINER_GPU_PATH: 'C:\\Mineradores\\SRBMiner-Multi-3-8-1\\SRBMiner-MULTI.exe', MINER_GPU_SHA256: 'A'.repeat(64) });
  assert.equal(ok.path, 'C:\\Mineradores\\SRBMiner-Multi-3-8-1\\SRBMiner-MULTI.exe');
  assert.equal(ok.sha256, 'a'.repeat(64));
  assert.equal(ok.worker, 'rtx3050');
  assert.deepEqual(ok.problemas, []);
  assert.match(minerGpuConfig({ MINER_GPU_PATH: 'SRBMiner-MULTI.exe' }).problemas[0], /absoluto/);
  assert.match(minerGpuConfig({ MINER_GPU_PATH: 'C:\\Windows\\System32\\cmd.exe' }).problemas[0], /SRBMiner-MULTI\.exe/);
  assert.match(minerGpuConfig({ MINER_GPU_SHA256: 'abc' }).problemas[0], /64/);
  assert.match(minerGpuConfig({ MINER_WORKER: 'meu worker' }).problemas[0], /MINER_WORKER/);
  assert.equal(minerGpuConfig({}).path, undefined);
});

// ---------------- executor do teste ----------------

const gpuAt = (temp: number, power = 55): { read(): Promise<GpuView> } => ({
  read: async () => ({
    mineracao: 'x', hardware: 'VERIFICADO', status: 'ok', mensagem: 'ok', procedencia: 'real', coletadoEm: null, idadeSegundos: 0, consultadoEm: null, eventos: [],
    gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 3050', driverVersion: '591.86', temperatureC: temp, powerW: power, powerLimitW: 70, utilizationPct: 99, memoryUsedMiB: 3000, memoryTotalMiB: 6144, fanPct: 60, pstate: 'P2', procedencia: 'real' }],
  }),
});

async function runner(mode: string, gpu = gpuAt(60)) {
  process.env.FAKE_SRB_MODE = mode;
  const sup = new ProcessSupervisor([{ id: 'srbminer', path: FAKE, sha256: await sha256File(FAKE) }]);
  const mining = new MiningStateMachine();
  const metrics: Metric[] = [];
  const reports: TestReport[] = [];
  const logDir = mkdtempSync(join(tmpdir(), 'srb-'));
  const r = new MiningTestRunner({ supervisor: sup, binaryId: 'srbminer', mining, gpu, putMetric: (m) => metrics.push(m), saveReport: (x) => reports.push(x), logDir, maxTempC: 80, criticalTempC: 90, tickMs: 60_000 });
  mining.transition('PRONTA PARA TESTE', 'teste', 'pré-condições conferidas');
  const args = buildSrbArgs({ profile: PROFILE, wallet: ADDR, worker: 'rtx3050', gpuOffTempC: 80 });
  return { r, sup, mining, metrics, reports, args };
}

test('executor: com hashrate do minerador vai a MINERANDO; INTERROMPER encerra, confirma e gera relatório', POSIX, async () => {
  const { r, sup, mining, metrics, reports, args } = await runner('ok');
  await r.start({ coin: 'PRL', durationMin: 5, args, profile: PROFILE, worker: 'rtx3050' });
  assert.equal(mining.state, 'INICIANDO');
  await sleep(400);
  await r.tick();
  assert.equal(mining.state, 'MINERANDO');
  await sleep(250);
  await r.tick();
  const rep = (await r.stop('INTERROMPER pelo operador'))!;
  assert.equal(sup.isRunning(), false, 'processo encerrado e confirmado');
  assert.equal(mining.state, 'PARADA');
  assert.equal(rep.motivoFim, 'INTERROMPER pelo operador');
  assert.equal(rep.hashrate.ultimoHs, 25.1e12);
  assert.ok(rep.shares.aceitas >= 3);
  assert.ok(rep.shares.rejeitadas >= 1);
  assert.ok(rep.energiaMedida && rep.energiaMedida.duringMining && rep.energiaMedida.avgW === 55);
  assert.ok(rep.comprovado.some((c) => /hashrate/.test(c)));
  assert.ok(rep.naoComprovado.some((c) => /saldo e pagamento/.test(c)));
  assert.equal(reports.length, 1);
  const log = readFileSync(rep.console.arquivo, 'utf8');
  assert.match(log, /--algorithm pearlhash --pool prl-br\.kryptex\.network:7048/);
  assert.match(log, /result accepted/);
  assert.ok(metrics.some((m) => m.key === 'miner.hashrate_hs' && m.provenance === 'real' && m.value === 25.1e12));
  assert.ok(metrics.some((m) => m.key === 'miner.pool_connected' && m.value === true));
  const t = mining.history().map((h) => h.to);
  assert.deepEqual(t.slice(-5), ['PRONTA PARA TESTE', 'TESTE AUTORIZADO', 'INICIANDO', 'MINERANDO', 'PARADA']);
});

test('executor: temperatura crítica para o teste na hora', POSIX, async () => {
  const { r, sup, mining, args } = await runner('ok', gpuAt(92));
  await r.start({ coin: 'PRL', durationMin: 5, args, profile: PROFILE, worker: 'rtx3050' });
  await sleep(200);
  await r.tick();
  assert.equal(sup.isRunning(), false);
  assert.equal(mining.state, 'PARADA');
  assert.match(r.current()!.motivoFim!, /temperatura crítica: 92/);
});

test('executor: minerador que fecha sozinho termina em PARADA, sem hashrate inventado', POSIX, async () => {
  const { r, mining, args } = await runner('crash');
  await r.start({ coin: 'PRL', durationMin: 5, args, profile: PROFILE, worker: 'rtx3050' });
  await sleep(600);
  await r.tick();
  assert.equal(mining.state, 'PARADA');
  const rep = r.current()!;
  assert.equal(rep.codigoSaida, 3);
  assert.equal(rep.hashrate.ultimoHs, undefined);
  assert.ok(rep.naoComprovado.some((c) => /nenhum hashrate/.test(c)));
  assert.ok(!mining.history().some((h) => h.to === 'MINERANDO'));
});

test('executor: sem "Total:" reconhecível nunca chega a MINERANDO e o relatório pede o log', POSIX, async () => {
  const { r, mining, args } = await runner('weird');
  await r.start({ coin: 'PRL', durationMin: 5, args, profile: PROFILE, worker: 'rtx3050' });
  await sleep(300);
  await r.tick();
  assert.equal(mining.state, 'INICIANDO');
  const rep = (await r.stop('fim do teste'))!;
  assert.ok(rep.console.linhasTotalNaoReconhecidas > 0);
  assert.ok(rep.naoComprovado.some((c) => /formato não reconhecido/.test(c)));
});

test('executor: SHA-256 que não confere não inicia nada e registra ERRO → PARADA', POSIX, async () => {
  process.env.FAKE_SRB_MODE = 'ok';
  const sup = new ProcessSupervisor([{ id: 'srbminer', path: FAKE, sha256: 'b'.repeat(64) }]);
  const mining = new MiningStateMachine();
  const r = new MiningTestRunner({ supervisor: sup, binaryId: 'srbminer', mining, gpu: gpuAt(50), putMetric: () => {}, saveReport: () => {}, logDir: mkdtempSync(join(tmpdir(), 'srb-')), maxTempC: 80, criticalTempC: 90, tickMs: 60_000 });
  mining.transition('PRONTA PARA TESTE', 'teste', 'ok');
  await assert.rejects(r.start({ coin: 'PRL', durationMin: 5, args: [], profile: PROFILE, worker: 'w' }), /integridade recusada/);
  assert.equal(sup.isRunning(), false);
  assert.deepEqual(mining.history().slice(-2).map((h) => h.to), ['ERRO', 'PARADA']);
});

// ---------------- API completa (com minerador falso) ----------------

const CSV = (temp: number) => `0, NVIDIA GeForce RTX 3050, 591.86, ${temp}, 55.0, 70.00, 99, 3000, 6144, 60, P2`;

async function withMinerServer(fn: (b: string, app: ReturnType<typeof makeApp>) => Promise<void>, over: Parameters<typeof makeApp>[0] = {}) {
  process.env.FAKE_SRB_MODE = 'ok';
  const gpuMonitor = new GpuMonitor({ runner: async () => ({ stdout: CSV(55), stderr: '', code: 0 }) });
  const app = makeApp({ allowedPools: [KRYPTEX], payoutAddresses: { PRL: ADDR }, dataDir: mkdtempSync(join(tmpdir(), 'srbapi-')), ...over }, { gpuMonitor, minerBinary: { path: FAKE, sha256: await sha256File(FAKE) }, runnerTickMs: 50 });
  const server = createApiServer(app, 'web');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const b = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try { await fn(b, app); } finally {
    await app.runner?.stop('fim do teste automatizado');
    await new Promise<void>((r) => server.close(() => r()));
  }
}
const post = (b: string, path: string, body: unknown) => fetch(`${b}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('API: sem a frase digitada, nada é iniciado', POSIX, async () => {
  await withMinerServer(async (b, app) => {
    const r = await post(b, '/api/mining/test/start', { coin: 'PRL', durationMin: 1 });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /AUTORIZO TESTE DE MINERAÇÃO/);
    const r2 = await post(b, '/api/mining/test/start', { coin: 'PRL', durationMin: 1, confirmacao: 'autorizo' });
    assert.equal(r2.status, 400);
    assert.equal(app.supervisor!.isRunning(), false);
    assert.equal(app.mining.state, 'DESATIVADA');
  });
});

test('API: teste completo com minerador falso — pré-condições, início, MINERANDO, INTERROMPER e relatório', POSIX, async () => {
  await withMinerServer(async (b, app) => {
    const chk = await (await post(b, '/api/mining/test/check', { coin: 'PRL', durationMin: 1 })).json();
    assert.deepEqual(chk.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { item: string }) => c.item), []);
    assert.equal(chk.estado, 'PRONTA PARA TESTE');
    const st = await post(b, '/api/mining/test/start', { coin: 'PRL', durationMin: 1, confirmacao: AUTH_PHRASE });
    assert.equal(st.status, 200);
    await sleep(600);
    const s = await (await fetch(`${b}/api/mining/state`)).json();
    assert.equal(s.estado, 'MINERANDO');
    assert.equal(s.indicadores.processoAtivo.estado, 'REAL');
    assert.equal(s.indicadores.hashrateLocal.estado, 'REAL');
    assert.equal(s.indicadores.workerConectado.estado, 'REAL');
    assert.ok(s.testeAtual.console.ultimas.some((l: string) => /result accepted/.test(l)));
    const gpu = await (await fetch(`${b}/api/gpu`)).json();
    assert.equal(gpu.mineracao, 'MINERANDO');
    const stop = await (await post(b, '/api/mining/stop', {})).json();
    assert.equal(stop.estado, 'PARADA');
    assert.equal(app.supervisor!.isRunning(), false);
    const after = await (await fetch(`${b}/api/mining/state`)).json();
    assert.equal(after.testeAtual, null);
    assert.equal(after.ultimoTeste.motivoFim, 'INTERROMPER pelo operador');
    assert.ok(existsSync(after.ultimoTeste.console.arquivo));
    const en = await (await fetch(`${b}/api/energy`)).json();
    assert.equal(en.medido.disponivel, false, 'menos de 10 amostras: modalidade B continua indisponível');
    assert.match(en.medido.motivo, /poucas amostras/);
  });
});

test('API: hash do arquivo configurado que não confere bloqueia o teste', POSIX, async () => {
  const app = makeApp({ minerGpu: { path: FAKE, sha256: 'c'.repeat(64), worker: 'rtx3050', problemas: [] }, allowedPools: [KRYPTEX], payoutAddresses: { PRL: ADDR } }, {
    gpuMonitor: new GpuMonitor({ runner: async () => ({ stdout: CSV(50), stderr: '', code: 0 }) }),
  });
  const server = createApiServer(app, 'web');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const b = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const chk = await (await post(b, '/api/mining/test/check', { coin: 'PRL' })).json();
    const m = chk.checks.find((c: { item: string }) => c.item.startsWith('Minerador'));
    assert.equal(m.ok, false);
    assert.match(m.detalhe, /NÃO confere/);
    const st = await post(b, '/api/mining/test/start', { coin: 'PRL', confirmacao: AUTH_PHRASE });
    assert.equal(st.status, 409);
    assert.equal(app.supervisor!.isRunning(), false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
