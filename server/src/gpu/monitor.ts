// Monitor de GPU: lê o nvidia-smi com cache curto, marca dados antigos e registra eventos.
// Nunca lança exceção para o chamador: falhas viram estado "indisponivel", "ausente", "erro_leitura" ou "desatualizado".
import { NvidiaSmiError, defaultRunner, readNvidiaSmi, type CommandRunner, type GpuReading } from './nvidiaSmi.ts';

export type GpuStatus = 'ok' | 'nvidia_smi_ausente' | 'indisponivel' | 'erro_leitura' | 'desatualizado' | 'nao_consultado';

export interface GpuMonitorOptions {
  smiPath?: string; // caminho absoluto opcional do nvidia-smi (ex.: C:\Windows\System32\nvidia-smi.exe)
  runner?: CommandRunner;
  timeoutMs?: number; // tempo limite de cada leitura
  staleMs?: number; // dado mais velho que isso não é mostrado como atual
  now?: () => number;
  maxEvents?: number;
}

export interface GpuEvent {
  at: string;
  level: 'info' | 'aviso' | 'erro';
  message: string;
}

export interface GpuView {
  /** A mineração nunca é iniciada por este módulo. */
  mineracao: 'DESATIVADA';
  /** "HARDWARE NÃO VERIFICADO" até a primeira leitura bem-sucedida do nvidia-smi neste processo. */
  hardware: 'VERIFICADO' | 'HARDWARE NÃO VERIFICADO';
  status: GpuStatus;
  mensagem: string;
  procedencia: 'real' | 'indisponivel';
  coletadoEm: string | null; // última leitura BEM-SUCEDIDA (mesmo que agora esteja em erro)
  idadeSegundos: number | null;
  consultadoEm: string | null; // última tentativa de leitura, com sucesso ou não
  gpus: (GpuReading & { procedencia: 'real' })[] | null; // null quando não há leitura atual confiável
  eventos: GpuEvent[];
}

const MESSAGES: Record<GpuStatus, string> = {
  ok: 'Leitura atual do nvidia-smi.',
  nvidia_smi_ausente: 'nvidia-smi não encontrado. Instale o driver NVIDIA ou ajuste NVIDIA_SMI_PATH.',
  indisponivel: 'GPU indisponível para leitura.',
  erro_leitura: 'Falha ao interpretar a saída do nvidia-smi.',
  desatualizado: 'Última leitura é antiga; os valores não são exibidos como atuais.',
  nao_consultado: 'Nenhuma leitura feita ainda.',
};

export class GpuMonitor {
  private runner: CommandRunner;
  private smi: string;
  private timeoutMs: number;
  private staleMs: number;
  private now: () => number;
  private maxEvents: number;
  private lastOk?: { at: number; gpus: GpuReading[] };
  private status: GpuStatus = 'nao_consultado';
  private message = MESSAGES.nao_consultado;
  private events: GpuEvent[] = [];
  private inflight?: Promise<GpuView>;
  private lastRead = 0;
  private cacheMs = 5000;

  constructor(opts: GpuMonitorOptions = {}) {
    this.smi = opts.smiPath ?? 'nvidia-smi';
    if (opts.smiPath && !isSafeSmiPath(opts.smiPath)) throw new Error('NVIDIA_SMI_PATH deve ser um caminho absoluto terminado em nvidia-smi ou nvidia-smi.exe');
    this.runner = opts.runner ?? defaultRunner;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.staleMs = opts.staleMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.maxEvents = opts.maxEvents ?? 50;
  }

  private log(level: GpuEvent['level'], message: string): void {
    this.events.push({ at: new Date(this.now()).toISOString(), level, message });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  /** Lê a GPU (ou devolve o cache recente). Nunca executa mineradores. */
  read(force = false): Promise<GpuView> {
    if (!force && this.inflight) return this.inflight;
    if (!force && this.lastRead && this.now() - this.lastRead < this.cacheMs) return Promise.resolve(this.view());
    this.inflight = this.doRead().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async doRead(): Promise<GpuView> {
    this.lastRead = this.now();
    try {
      const gpus = await readNvidiaSmi(this.smi, this.runner, this.timeoutMs);
      if (gpus.length === 0) {
        this.setState('indisponivel');
        this.log('aviso', 'nvidia-smi não listou nenhuma GPU');
      } else {
        const changed = this.status !== 'ok';
        this.lastOk = { at: this.now(), gpus };
        this.setState('ok');
        if (changed) this.log('info', `${gpus.length} GPU(s) lida(s): ${gpus.map((g) => g.name).join(', ')}`);
      }
    } catch (e) {
      if (e instanceof NvidiaSmiError) {
        if (e.kind === 'ausente') this.setState('nvidia_smi_ausente', e.message);
        else if (e.kind === 'leitura_invalida') this.setState('erro_leitura', e.message);
        else this.setState('indisponivel', e.message);
      } else {
        this.setState('indisponivel', 'erro inesperado na leitura');
      }
    }
    return this.view();
  }

  private markStale(): void {
    this.status = 'desatualizado';
    this.message = MESSAGES.desatualizado;
    this.log('aviso', MESSAGES.desatualizado);
  }

  private setState(status: GpuStatus, detail?: string): void {
    const changed = status !== this.status;
    this.status = status;
    this.message = detail ? `${MESSAGES[status]} (${detail})` : MESSAGES[status];
    if (changed && status !== 'ok') this.log(status === 'nvidia_smi_ausente' || status === 'erro_leitura' ? 'erro' : 'aviso', this.message);
  }

  /** Momento da última leitura bem-sucedida (para não gravar a mesma amostra duas vezes no histórico). */
  lastSampleAt(): number | undefined {
    return this.lastOk?.at;
  }

  view(): GpuView {
    const age = this.lastOk ? this.now() - this.lastOk.at : null;
    const stale = age !== null && age > this.staleMs;
    const status: GpuStatus = stale && this.status === 'ok' ? 'desatualizado' : this.status;
    if (stale && this.status === 'ok') this.markStale();
    const current = status === 'ok' && this.lastOk && !stale;
    return {
      mineracao: 'DESATIVADA',
      hardware: this.lastOk ? 'VERIFICADO' : 'HARDWARE NÃO VERIFICADO',
      status,
      mensagem: status === this.status ? this.message : MESSAGES[status],
      procedencia: current ? 'real' : 'indisponivel',
      coletadoEm: this.lastOk ? new Date(this.lastOk.at).toISOString() : null,
      idadeSegundos: age === null ? null : Math.round(age / 1000),
      consultadoEm: this.lastRead ? new Date(this.lastRead).toISOString() : null,
      gpus: current ? this.lastOk!.gpus.map((g) => ({ ...g, procedencia: 'real' as const })) : null,
      eventos: this.events.slice(-20),
    };
  }
}

/** Aceita apenas caminhos absolutos cujo nome final seja nvidia-smi ou nvidia-smi.exe, sem metacaracteres de shell. */
export function isSafeSmiPath(p: string): boolean {
  const abs = /^([A-Za-z]:\\|\/)[^\0\n\r"'`$;&|<>*?]+$/.test(p);
  return abs && /(^|[\\/])nvidia-smi(\.exe)?$/i.test(p);
}
