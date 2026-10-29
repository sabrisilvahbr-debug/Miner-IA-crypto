import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GPU_QUERY_FIELDS, NVIDIA_SMI_ARGS, parseNvidiaSmiCsv, readNvidiaSmi, type CommandRunner } from '../src/gpu/nvidiaSmi.ts';
import { GpuMonitor, isSafeSmiPath } from '../src/gpu/monitor.ts';

const LINE = '0, NVIDIA GeForce RTX 3060, 552.44, 54, 118.25, 170.00, 87, 6120, 12288, 62, P2';
const NA_LINE = '0, NVIDIA GeForce RTX 3060, [N/A], [N/A], [Not Supported], 170.00, [N/A], [N/A], 12288, [N/A], P8';

/** Executor falso: nunca executa o nvidia-smi real. Guarda as chamadas para conferência. */
function fakeRunner(behaviour: 'ok' | 'ausente' | 'timeout' | 'saida' | 'custom', stdout = LINE) {
  const calls: { file: string; args: readonly string[]; timeoutMs: number }[] = [];
  const runner: CommandRunner = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs });
    if (behaviour === 'ausente') throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
    if (behaviour === 'timeout') throw Object.assign(new Error('timeout'), { killed: true, code: 'ETIMEDOUT' });
    if (behaviour === 'saida') return { stdout: '', stderr: 'NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver\nmais linhas', code: 9 };
    return { stdout, stderr: '', code: 0 };
  };
  return { runner, calls };
}

function clock(start = 1_000_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('parser: lê uma GPU com todos os campos', () => {
  const [g] = parseNvidiaSmiCsv(LINE);
  assert.equal(g.index, 0);
  assert.equal(g.name, 'NVIDIA GeForce RTX 3060');
  assert.equal(g.driverVersion, '552.44');
  assert.equal(g.temperatureC, 54);
  assert.equal(g.powerW, 118.25);
  assert.equal(g.powerLimitW, 170);
  assert.equal(g.memoryTotalMiB, 12288);
  assert.equal(g.pstate, 'P2');
});

test('parser: campos [N/A] viram ausentes (null), nunca zero', () => {
  const [g] = parseNvidiaSmiCsv(NA_LINE);
  assert.equal(g.temperatureC, null);
  assert.equal(g.powerW, null);
  assert.equal(g.utilizationPct, null);
  assert.equal(g.driverVersion, null);
  assert.equal(g.memoryTotalMiB, 12288, 'campo válido continua válido');
});

test('parser: número de colunas errado é erro de leitura', () => {
  assert.throws(() => parseNvidiaSmiCsv('0, RTX, 552'), /campos/);
});

test('parser: valor numérico inesperado é erro de leitura', () => {
  assert.throws(() => parseNvidiaSmiCsv(LINE.replace('54', 'quente')), /numérico/);
});

test('parser: saída vazia é erro de leitura', () => {
  assert.throws(() => parseNvidiaSmiCsv('\n   \n'), /vazia/);
});

test('leitura: chamada com argumentos fixos, sem shell e com o caminho configurado', async () => {
  const { runner, calls } = fakeRunner('ok');
  await readNvidiaSmi('nvidia-smi', runner, 4000);
  assert.equal(calls[0].file, 'nvidia-smi');
  assert.deepEqual([...calls[0].args], NVIDIA_SMI_ARGS);
  assert.ok(NVIDIA_SMI_ARGS[0].includes(GPU_QUERY_FIELDS.join(',')));
  assert.equal(calls[0].timeoutMs, 4000);
});

test('monitor: GPU lida vira dado real e atual', async () => {
  const c = clock();
  const { runner } = fakeRunner('ok');
  const m = new GpuMonitor({ runner, now: c.now });
  const v = await m.read();
  assert.equal(v.status, 'ok');
  assert.equal(v.procedencia, 'real');
  assert.equal(v.gpus?.[0].procedencia, 'real');
  assert.equal(v.modo, 'SIMULAÇÃO');
});

test('monitor: nvidia-smi ausente informa o motivo e não mostra GPU', async () => {
  const c = clock();
  const m = new GpuMonitor({ runner: fakeRunner('ausente').runner, now: c.now });
  const v = await m.read();
  assert.equal(v.status, 'nvidia_smi_ausente');
  assert.equal(v.gpus, null);
  assert.equal(v.procedencia, 'indisponivel');
  assert.match(v.eventos.at(-1)!.message, /nvidia-smi não encontrado/);
});

test('monitor: tempo esgotado vira indisponível', async () => {
  const c = clock();
  const v = await new GpuMonitor({ runner: fakeRunner('timeout').runner, now: c.now }).read();
  assert.equal(v.status, 'indisponivel');
  assert.match(v.mensagem, /tempo limite/);
});

test('monitor: código de saída diferente de zero vira indisponível com mensagem curta', async () => {
  const c = clock();
  const v = await new GpuMonitor({ runner: fakeRunner('saida').runner, now: c.now }).read();
  assert.equal(v.status, 'indisponivel');
  assert.equal(v.gpus, null);
  assert.ok(v.mensagem.length < 300);
});

test('monitor: saída inválida vira erro_leitura', async () => {
  const c = clock();
  const v = await new GpuMonitor({ runner: fakeRunner('custom', 'lixo, sem formato').runner, now: c.now }).read();
  assert.equal(v.status, 'erro_leitura');
  assert.equal(v.gpus, null);
});

test('monitor: dado antigo não é mostrado como atual', async () => {
  const c = clock();
  const m = new GpuMonitor({ runner: fakeRunner('ok').runner, now: c.now, staleMs: 30_000 });
  await m.read();
  c.advance(60_000);
  const v = m.view();
  assert.equal(v.status, 'desatualizado');
  assert.equal(v.gpus, null);
  assert.equal(v.procedencia, 'indisponivel');
  assert.equal(v.idadeSegundos, 60);
});

test('monitor: falha depois de leitura boa não reaproveita a GPU como atual', async () => {
  const c = clock();
  let fail = false;
  const runner: CommandRunner = async (f, a, t) => (fail ? fakeRunner('timeout').runner(f, a, t) : fakeRunner('ok').runner(f, a, t));
  const m = new GpuMonitor({ runner, now: c.now });
  await m.read();
  fail = true;
  c.advance(10_000);
  const v = await m.read(true);
  assert.equal(v.status, 'indisponivel');
  assert.equal(v.gpus, null);
});

test('monitor: cache curto evita chamadas repetidas ao nvidia-smi', async () => {
  const c = clock();
  const { runner, calls } = fakeRunner('ok');
  const m = new GpuMonitor({ runner, now: c.now });
  await m.read();
  await m.read();
  assert.equal(calls.length, 1);
  c.advance(6000);
  await m.read();
  assert.equal(calls.length, 2);
});

test('monitor: eventos registram mudanças de estado', async () => {
  const c = clock();
  const m = new GpuMonitor({ runner: fakeRunner('ausente').runner, now: c.now });
  await m.read(true);
  const v = m.view();
  assert.ok(v.eventos.some((e) => e.level === 'erro'));
});

test('caminho do nvidia-smi: aceita só caminho absoluto com o nome correto', () => {
  assert.equal(isSafeSmiPath('C:\\Windows\\System32\\nvidia-smi.exe'), true);
  assert.equal(isSafeSmiPath('/usr/bin/nvidia-smi'), true);
  assert.equal(isSafeSmiPath('nvidia-smi'), false, 'relativo não é aceito por padrão');
  assert.equal(isSafeSmiPath('C:\\x\\nvidia-smi.exe; calc'), false, 'metacaracteres são recusados');
  assert.equal(isSafeSmiPath('C:\\temp\\outro.exe'), false);
  assert.throws(() => new GpuMonitor({ smiPath: '/bin/sh' }), /nvidia-smi/);
});
