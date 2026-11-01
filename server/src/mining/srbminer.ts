// Integração com o SRBMiner-MULTI (https://github.com/doktor83/SRBMiner-Multi), só para o teste controlado.
//
// Argumentos: somente os documentados no arquivo "Parameters" oficial e no comando publicado pela pool
// (catalog.ts → minerProfile). Montados aqui, nunca recebidos do navegador. Nunca usados:
//  --api-enable/--api-port (a API aceita leitura por qualquer site: Access-Control-Allow-Origin: *),
//  --api-rig-restart-url/--api-rig-shutdown-url (reiniciam/desligam o computador pelo navegador),
//  --shutdown-temperature (desliga o computador).
//
// Leitura: pelo console do minerador. O formato da API e do console não é documentado oficialmente; as marcas
// usadas ("result accepted", "result rejected", "Total:") vêm do guia de mensagens do miner.download
// (https://www.miner.download/en-miner-messages/srbminer). Linha que não bate com o padrão é ignorada,
// nunca adivinhada. O log completo de cada teste é gravado para conferir o formato com uma amostra real.
import type { MinerProfile } from './catalog.ts';

export const SRBMINER = {
  id: 'srbminer',
  name: 'SRBMiner-MULTI',
  version: '3.8.1',
  exeName: 'SRBMiner-MULTI.exe',
  releasesUrl: 'https://github.com/doktor83/SRBMiner-Multi/releases',
  // Publicado na página de releases (só MD5; o arquivo .exe é conferido pelo SHA-256 que o operador informa).
  zipName: 'SRBMiner-Multi-3-8-1-win64.zip',
  zipMd5: 'd21d4ad2fe78118161b33c4c3437644e',
} as const;

export const WORKER_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const WALLET_RE = /^[A-Za-z0-9]{20,128}$/;
const HOSTPORT_RE = /^[a-z0-9.-]+\.[a-z]{2,}:\d{2,5}$/;
const FORBIDDEN = /^--(api-|shutdown-temperature)/;

export interface SrbArgsInput {
  profile: MinerProfile;
  wallet: string;
  worker: string;
  gpuOffTempC: number;
}

export function buildSrbArgs(i: SrbArgsInput): string[] {
  if (i.profile.miner !== 'srbminer-multi') throw new Error('perfil não é do SRBMiner-MULTI');
  if (!/^[a-z0-9_]{2,32}$/.test(i.profile.algorithm)) throw new Error('algoritmo inválido no catálogo');
  if (!HOSTPORT_RE.test(i.profile.poolHostPort)) throw new Error('endereço da pool inválido no catálogo');
  if (!WALLET_RE.test(i.wallet)) throw new Error('endereço de recebimento inválido (só letras e números, 20 a 128 caracteres)');
  if (!WORKER_RE.test(i.worker)) throw new Error('nome do worker inválido (letras, números, _ ou -, até 32)');
  if (!(Number.isInteger(i.gpuOffTempC) && i.gpuOffTempC >= 50 && i.gpuOffTempC <= 90)) throw new Error('temperatura de desligamento da GPU fora de 50–90 °C');
  const args = [
    '--disable-cpu',
    '--disable-gpu-amd',
    '--disable-gpu-intel',
    '--algorithm', i.profile.algorithm,
    '--pool', i.profile.poolHostPort,
    '--wallet', `${i.wallet}.${i.worker}`,
    '--gpu-off-temperature', String(i.gpuOffTempC),
  ];
  if (args.some((a) => FORBIDDEN.test(a))) throw new Error('argumento proibido');
  return args;
}

// ---------------------------------------------------------------- leitura do console

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const UNIT: Record<string, number> = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 };
const TOTAL_RE = /\bTotal:\s*([0-9]+(?:[.,][0-9]+)?)\s*([KMGTP]?)H\/s/i;

export interface ConsoleStats {
  hashrateHs?: number;
  hashrateRaw?: string; // trecho exatamente como o minerador escreveu
  hashrateAt?: number;
  accepted: number;
  rejected: number;
  lastShareAt?: number;
  jobs: number; // linhas com "new job": a pool está enviando trabalho
  lastJobAt?: number;
  lines: number;
  unmatchedTotalLines: number; // linhas com "Total:" em formato não reconhecido
}

export class SrbConsoleParser {
  private buf = '';
  private tail: string[] = [];
  readonly stats: ConsoleStats = { accepted: 0, rejected: 0, jobs: 0, lines: 0, unmatchedTotalLines: 0 };
  private now: () => number;
  private tailMax: number;

  constructor(now: () => number = Date.now, tailMax = 60) {
    this.now = now;
    this.tailMax = tailMax;
  }

  feed(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split(/\r?\n|\r/);
    this.buf = parts.pop() ?? '';
    const out: string[] = [];
    for (const raw of parts) {
      const line = raw.replace(ANSI, '').trimEnd();
      if (!line.trim()) continue;
      out.push(line);
      this.line(line);
    }
    return out;
  }

  private line(line: string): void {
    const t = this.now();
    this.stats.lines++;
    this.tail.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
    if (this.tail.length > this.tailMax) this.tail.splice(0, this.tail.length - this.tailMax);
    if (/result accepted/i.test(line)) { this.stats.accepted++; this.stats.lastShareAt = t; }
    if (/result rejected/i.test(line)) { this.stats.rejected++; this.stats.lastShareAt = t; }
    if (/new job/i.test(line)) { this.stats.jobs++; this.stats.lastJobAt = t; }
    if (/\bTotal:/i.test(line)) {
      const m = TOTAL_RE.exec(line);
      const value = m ? Number(m[1].replace(',', '.')) * UNIT[m[2].toUpperCase()] : NaN;
      if (m && Number.isFinite(value) && value >= 0) {
        this.stats.hashrateHs = value;
        this.stats.hashrateRaw = m[0];
        this.stats.hashrateAt = t;
      } else {
        this.stats.unmatchedTotalLines++;
      }
    }
  }

  lastLines(n = 30): string[] {
    return this.tail.slice(-n);
  }
}
