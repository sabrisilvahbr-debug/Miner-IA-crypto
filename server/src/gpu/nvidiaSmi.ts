// Leitura de GPU NVIDIA pelo nvidia-smi. SOMENTE LEITURA: comando fixo, sem shell, sem entrada do usuário.
// Não inicia nem consulta mineradores. Cada valor é "real" (lido do nvidia-smi) ou fica ausente (null).
import { execFile } from 'node:child_process';

/** Campos consultados. A ordem precisa bater com o parser. */
export const GPU_QUERY_FIELDS = [
  'index',
  'name',
  'driver_version',
  'temperature.gpu',
  'power.draw',
  'power.limit',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'fan.speed',
  'pstate',
] as const;

export const NVIDIA_SMI_ARGS = [
  `--query-gpu=${GPU_QUERY_FIELDS.join(',')}`,
  '--format=csv,noheader,nounits',
];

export interface GpuReading {
  index: number;
  name: string;
  driverVersion: string | null;
  temperatureC: number | null;
  powerW: number | null;
  powerLimitW: number | null;
  utilizationPct: number | null;
  memoryUsedMiB: number | null;
  memoryTotalMiB: number | null;
  fanPct: number | null;
  pstate: string | null;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Executor injetável: nos testes ele é simulado. Em produção, roda o nvidia-smi sem shell. */
export type CommandRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>;

export type NvidiaSmiErrorKind = 'ausente' | 'tempo_esgotado' | 'falha' | 'leitura_invalida';

export class NvidiaSmiError extends Error {
  readonly kind: NvidiaSmiErrorKind;
  constructor(kind: NvidiaSmiErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const MISSING = /^\s*(\[?\s*(N\/A|Not Supported|Unknown Error|Not available)\s*\]?)\s*$/i;

function num(raw: string): number | null {
  const t = raw.trim();
  if (t === '' || MISSING.test(t)) return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new NvidiaSmiError('leitura_invalida', `valor numérico inesperado: "${t.slice(0, 20)}"`);
  return Number(t);
}

function text(raw: string): string | null {
  const t = raw.trim();
  if (t === '' || MISSING.test(t)) return null;
  return t.slice(0, 120);
}

/** Converte a saída CSV do nvidia-smi. Lança NvidiaSmiError se o formato não bater. */
export function parseNvidiaSmiCsv(stdout: string): GpuReading[] {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) throw new NvidiaSmiError('leitura_invalida', 'saída vazia do nvidia-smi');
  const expected = GPU_QUERY_FIELDS.length;
  return lines.map((line) => {
    const c = line.split(',');
    if (c.length !== expected) {
      throw new NvidiaSmiError('leitura_invalida', `linha com ${c.length} campos; esperado ${expected}`);
    }
    const index = num(c[0]);
    if (index === null || !Number.isInteger(index) || index < 0) throw new NvidiaSmiError('leitura_invalida', 'índice de GPU inválido');
    const name = text(c[1]);
    if (!name) throw new NvidiaSmiError('leitura_invalida', 'GPU sem nome');
    return {
      index,
      name,
      driverVersion: text(c[2]),
      temperatureC: num(c[3]),
      powerW: num(c[4]),
      powerLimitW: num(c[5]),
      utilizationPct: num(c[6]),
      memoryUsedMiB: num(c[7]),
      memoryTotalMiB: num(c[8]),
      fanPct: num(c[9]),
      pstate: text(c[10]),
    };
  });
}

/** Executa o nvidia-smi com argumentos fixos. Nunca usa shell e nunca recebe entrada externa. */
export async function readNvidiaSmi(file: string, runner: CommandRunner, timeoutMs: number): Promise<GpuReading[]> {
  let res: CommandResult;
  try {
    res = await runner(file, NVIDIA_SMI_ARGS, timeoutMs);
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (err.code === 'ENOENT') throw new NvidiaSmiError('ausente', 'nvidia-smi não encontrado (driver NVIDIA ausente ou fora do PATH)');
    if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') throw new NvidiaSmiError('tempo_esgotado', 'nvidia-smi não respondeu no tempo limite');
    throw new NvidiaSmiError('falha', 'falha ao executar nvidia-smi');
  }
  if (res.code !== 0) {
    // Mensagem curta e sem caminhos completos do sistema.
    const msg = res.stderr.split(/\r?\n/)[0]?.slice(0, 160) || `código de saída ${res.code}`;
    throw new NvidiaSmiError('falha', `nvidia-smi retornou erro: ${msg}`);
  }
  return parseNvidiaSmiCsv(res.stdout);
}

/** Runner real. Usa execFile (sem shell), tempo limite e buffer limitado. */
export const defaultRunner: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err);
      if (err && (err as { killed?: boolean }).killed) return reject(Object.assign(err, { code: 'ETIMEDOUT' }));
      const code = err ? Number((err as { code?: unknown }).code) || 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
