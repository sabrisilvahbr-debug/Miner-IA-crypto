// Supervisor de processos de mineração. Só é criado quando MINER_GPU_PATH e MINER_GPU_SHA256 estão no .env.
// Regras:
//  - só executa um binário com caminho absoluto e SHA-256 conferido (lista explícita, nunca vinda da interface);
//  - argumentos montados pelo backend, nunca recebidos do navegador; sem shell;
//  - tempo máximo obrigatório; encerramento com SIGTERM e, se preciso, SIGKILL; confirma que o processo saiu.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export interface AllowedBinary {
  id: string;
  path: string; // absoluto
  sha256: string; // hash esperado (hex minúsculo)
}

export interface RunSpec {
  binaryId: string;
  args: string[]; // montados pelo backend
  maxRuntimeMs: number;
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void; // console do processo (somente leitura)
  cwd?: string; // pasta de trabalho; por padrão, a pasta do próprio binário
}

export interface ProcessRecord {
  binaryId: string;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  reason?: string;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => resolve()).on('error', reject);
  });
  return h.digest('hex');
}

export class ProcessSupervisor {
  private allowed: Map<string, AllowedBinary>;
  private child?: ChildProcess;
  private record?: ProcessRecord;
  private timer?: NodeJS.Timeout;
  private exited?: Promise<void>;
  private now: () => number;

  constructor(allowed: AllowedBinary[], now: () => number = Date.now) {
    for (const b of allowed) {
      if (!isAbsolute(b.path)) throw new Error(`binário ${b.id}: caminho precisa ser absoluto`);
      if (!/^[0-9a-f]{64}$/.test(b.sha256)) throw new Error(`binário ${b.id}: SHA-256 inválido`);
    }
    this.allowed = new Map(allowed.map((b) => [b.id, b]));
    this.now = now;
  }

  isRunning(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  last(): ProcessRecord | undefined {
    return this.record ? { ...this.record } : undefined;
  }

  async start(spec: RunSpec): Promise<ProcessRecord> {
    if (this.isRunning()) throw new Error('já existe um processo em execução');
    const bin = this.allowed.get(spec.binaryId);
    if (!bin) throw new Error(`binário "${spec.binaryId}" não está na lista permitida`);
    if (!(spec.maxRuntimeMs > 0 && spec.maxRuntimeMs <= 60 * 60_000)) throw new Error('tempo máximo deve estar entre 1 ms e 60 min');
    if (!spec.args.every((a) => typeof a === 'string' && a.length < 512 && !/[\0\r\n]/.test(a))) throw new Error('argumento inválido');
    const actual = await sha256File(bin.path);
    if (actual !== bin.sha256) throw new Error(`integridade recusada: SHA-256 de ${bin.id} não confere`);

    const child = spawn(bin.path, spec.args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: spec.cwd ?? dirname(bin.path) });
    this.child = child;
    this.record = { binaryId: bin.id, pid: child.pid, startedAt: this.now() };
    this.exited = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        if (this.timer) clearTimeout(this.timer);
        this.record = { ...this.record!, endedAt: this.now(), exitCode: code, signal, reason: this.record?.reason ?? 'processo terminou sozinho' };
        resolve();
      });
      child.once('error', (e) => {
        this.record = { ...this.record!, endedAt: this.now(), exitCode: null, reason: `falha ao iniciar: ${e.message}` };
        resolve();
      });
    });
    if (spec.onOutput) {
      const cb = spec.onOutput;
      child.stdout?.setEncoding('utf8').on('data', (t: string) => { try { cb(t, 'stdout'); } catch { /* leitor nunca derruba o processo */ } });
      child.stderr?.setEncoding('utf8').on('data', (t: string) => { try { cb(t, 'stderr'); } catch { /* idem */ } });
    } else {
      child.stdout?.resume();
      child.stderr?.resume();
    }
    this.timer = setTimeout(() => void this.stop('tempo máximo de segurança atingido'), spec.maxRuntimeMs);
    return { ...this.record };
  }

  /** Último recurso, síncrono (evento "exit" do Node): no Windows, o filho não morre junto com o pai. */
  killNow(): void {
    if (this.isRunning()) {
      try { this.child!.kill('SIGKILL'); } catch { /* já saiu */ }
    }
  }

  /** Encerra e CONFIRMA que o processo saiu. Retorna o registro final. */
  async stop(reason = 'interrompido pelo operador', graceMs = 5000): Promise<ProcessRecord | undefined> {
    if (!this.child || !this.exited) return this.record;
    if (this.isRunning()) {
      this.record = { ...this.record!, reason };
      this.child.kill('SIGTERM');
      const timedOut = await Promise.race([this.exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), graceMs))]);
      if (timedOut && this.isRunning()) {
        this.child.kill('SIGKILL');
        await this.exited;
      }
    }
    await this.exited;
    if (this.isRunning()) throw new Error('o processo não foi encerrado');
    return this.last();
  }
}
