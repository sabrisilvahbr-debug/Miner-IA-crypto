// Adaptadores de minerador. Somente leitura, exceto pausa/retomada do XMRig,
// que só é executada pelo Executor (agente 37) após Guardião de Risco e aprovação humana.
import { connect } from 'node:net';
import type { Provenance } from '../core/types.ts';
import type { HttpClient } from '../core/rateLimiter.ts';
import { DisconnectedError } from '../core/rateLimiter.ts';
import type { AppConfig } from '../config.ts';
import { SIM_EPOCH, wave } from './sim.ts';

export interface MinerSummary {
  connected: boolean;
  provenance: Provenance;
  source: string;
  version?: string;
  algo?: string;
  hashrateHs?: number; // média recente (H/s)
  hashrate15mHs?: number;
  sharesGood?: number;
  sharesTotal?: number;
  uptimeS?: number;
  poolUrl?: string;
  temperatureC?: number | null;
  threads?: number;
  hardware?: string;
  powerW?: number;
  latencyMs?: number;
}

export interface MinerAdapter {
  readonly type: string;
  readonly provenance: Provenance;
  summary(): Promise<MinerSummary>;
  control?(cmd: 'pause' | 'resume'): Promise<string>;
}

export class NoMinerAdapter implements MinerAdapter {
  readonly type = 'none';
  readonly provenance: Provenance = 'real';
  private reason: string;
  constructor(reason = 'nenhum minerador configurado (MINER_TYPE=none)') {
    this.reason = reason;
  }
  async summary(): Promise<MinerSummary> {
    throw new DisconnectedError(this.reason);
  }
}

export class SimulatedMinerAdapter implements MinerAdapter {
  readonly type = 'simulated';
  readonly provenance: Provenance = 'simulado';
  private now: () => number;
  private algo: string;
  paused = false;
  constructor(algo: string, now: () => number = Date.now) {
    this.now = now;
    this.algo = algo;
  }
  async summary(): Promise<MinerSummary> {
    const t = this.now();
    const uptimeS = Math.floor((t - SIM_EPOCH) / 1000) % (86400 * 9);
    const sha = this.algo.startsWith('sha256');
    const base = sha ? 110e12 : 12_000; // ASIC SHA-256 simulado ou CPU RandomX simulada
    // Queda simulada de desempenho por ~4 minutos a cada 2 horas, para exercitar o detector de anomalias.
    const dip = (t % 7_200_000) < 240_000 ? 0.55 : 1;
    const hashrate = this.paused ? 0 : base * (1 + wave(t, 600_000, 2) * 0.03) * dip;
    const sharesTotal = Math.floor(uptimeS / 9);
    return {
      connected: true,
      provenance: 'simulado',
      source: 'simulador',
      version: sha ? 'sim-asic/1.0' : 'sim-xmrig/6.0',
      algo: this.algo,
      hashrateHs: hashrate,
      hashrate15mHs: this.paused ? 0 : base * (1 + wave(t, 3_600_000, 4) * 0.01),
      sharesTotal,
      sharesGood: Math.floor(sharesTotal * 0.992),
      uptimeS,
      poolUrl: 'stratum+tcp://pool.simulada.local:3333',
      temperatureC: this.paused ? 40 : Math.round((70 + wave(t, 1_800_000, 7) * 7) * 10) / 10,
      threads: sha ? undefined : 16,
      hardware: sha ? 'ASIC SHA-256 (simulado)' : 'CPU 16 threads (simulada)',
      powerW: this.paused ? 0 : sha ? 3250 : 140,
      latencyMs: Math.round(40 + wave(t, 300_000, 9) * 15),
    };
  }
  async control(cmd: 'pause' | 'resume'): Promise<string> {
    this.paused = cmd === 'pause';
    return `simulador ${cmd === 'pause' ? 'pausado' : 'retomado'}`;
  }
}

/** XMRig HTTP API (GET /2/summary). Exige "http.enabled" no config.json do XMRig. */
export class XmrigAdapter implements MinerAdapter {
  readonly type = 'xmrig';
  readonly provenance: Provenance = 'real';
  private http: HttpClient;
  private url: string;
  private token?: string;
  constructor(http: HttpClient, url: string, token?: string) {
    this.http = http;
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }
  private headers(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }
  async summary(): Promise<MinerSummary> {
    const started = Date.now();
    const d = await this.http.getJson<Record<string, any>>(`${this.url}/2/summary`, { headers: this.headers(), timeoutMs: 5000 });
    const hr: (number | null)[] = d?.hashrate?.total ?? [];
    return {
      connected: true,
      provenance: 'real',
      source: 'xmrig',
      version: d?.version,
      algo: d?.algo,
      hashrateHs: hr[0] ?? hr[1] ?? undefined,
      hashrate15mHs: hr[2] ?? undefined,
      sharesGood: d?.results?.shares_good,
      sharesTotal: d?.results?.shares_total,
      uptimeS: d?.uptime,
      poolUrl: d?.connection?.pool,
      temperatureC: null, // a API de resumo do XMRig não informa temperatura de CPU
      threads: d?.cpu?.threads ?? d?.cpu?.cores,
      hardware: d?.cpu?.brand,
      latencyMs: Date.now() - started,
    };
  }
  async control(cmd: 'pause' | 'resume'): Promise<string> {
    await this.http.postJson(`${this.url}/json_rpc`, { jsonrpc: '2.0', id: 1, method: cmd }, { headers: this.headers() });
    return `XMRig: comando ${cmd} enviado`;
  }
}

/** API TCP do cgminer/bmminer (porta 4028), usada por muitos ASICs de Bitcoin. Somente leitura. */
export class CgminerAdapter implements MinerAdapter {
  readonly type = 'cgminer';
  readonly provenance: Provenance = 'real';
  private host: string;
  private port: number;
  constructor(url: string) {
    const u = new URL(url.includes('://') ? url : `tcp://${url}`);
    this.host = u.hostname;
    this.port = Number(u.port || 4028);
  }
  private command(command: string): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const sock = connect({ host: this.host, port: this.port });
      let buf = '';
      sock.setTimeout(5000, () => {
        sock.destroy();
        reject(new DisconnectedError(`tempo esgotado em ${this.host}:${this.port}`));
      });
      sock.on('connect', () => sock.write(JSON.stringify({ command })));
      sock.on('data', (c) => (buf += c.toString('utf8')));
      sock.on('error', (e) => reject(new DisconnectedError(`cgminer ${this.host}:${this.port}: ${e.message}`)));
      sock.on('end', () => {
        try {
          resolve(JSON.parse(buf.replace(/\0/g, '').trim()));
        } catch {
          reject(new Error('resposta inválida da API cgminer'));
        }
      });
    });
  }
  async summary(): Promise<MinerSummary> {
    const started = Date.now();
    const s = await this.command('summary');
    const latencyMs = Date.now() - started;
    const sum = s?.SUMMARY?.[0] ?? {};
    let version: string | undefined;
    try {
      const v = await this.command('version');
      const vv = v?.VERSION?.[0] ?? {};
      version = vv.CGMiner ?? vv.BMMiner ?? vv.BOSminer ?? vv.Miner;
    } catch {
      version = undefined;
    }
    const mhs = Number(sum['MHS av'] ?? sum['MHS 5s'] ?? NaN);
    const ghs = Number(sum['GHS av'] ?? sum['GHS 5s'] ?? NaN);
    const hashrateHs = Number.isFinite(mhs) ? mhs * 1e6 : Number.isFinite(ghs) ? ghs * 1e9 : undefined;
    const accepted = Number(sum.Accepted ?? NaN);
    const rejected = Number(sum.Rejected ?? 0);
    return {
      connected: true,
      provenance: 'real',
      source: 'cgminer',
      version,
      algo: 'sha256d',
      hashrateHs,
      sharesGood: Number.isFinite(accepted) ? accepted : undefined,
      sharesTotal: Number.isFinite(accepted) ? accepted + rejected : undefined,
      uptimeS: sum.Elapsed !== undefined ? Number(sum.Elapsed) : undefined,
      temperatureC: null,
      hardware: 'ASIC (API cgminer)',
      latencyMs,
    };
  }
}

/** Serviço compartilhado: uma leitura do minerador serve vários agentes (evita chamadas duplicadas). */
export class MinerService {
  readonly adapter: MinerAdapter;
  private cache?: { at: number; value?: MinerSummary; error?: Error };
  private inflight?: Promise<MinerSummary>;
  private ttlMs: number;
  private now: () => number;
  constructor(adapter: MinerAdapter, ttlMs = 5000, now: () => number = Date.now) {
    this.adapter = adapter;
    this.ttlMs = ttlMs;
    this.now = now;
  }
  async summary(): Promise<MinerSummary> {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) {
      if (this.cache.error) throw this.cache.error;
      return this.cache.value!;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.adapter
      .summary()
      .then((v) => {
        this.cache = { at: this.now(), value: v };
        return v;
      })
      .catch((e: Error) => {
        this.cache = { at: this.now(), error: e };
        throw e;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
  invalidate(): void {
    this.cache = undefined;
  }
}

export function createMinerAdapter(c: AppConfig, http: HttpClient, now: () => number): MinerAdapter {
  switch (c.minerType) {
    case 'simulated':
      if (c.appEnv !== 'test') throw new Error('minerador simulado recusado fora do ambiente de testes');
      return new SimulatedMinerAdapter(c.minerAlgo, now);
    case 'xmrig':
      return c.minerUrl ? new XmrigAdapter(http, c.minerUrl, c.minerAccessToken) : new NoMinerAdapter('MINER_URL vazio: aguardando o endereço do XMRig');
    case 'cgminer':
      return c.minerUrl ? new CgminerAdapter(c.minerUrl) : new NoMinerAdapter('MINER_URL vazio: aguardando o IP do ASIC (tcp://IP-DO-ASIC:4028)');
    default:
      return new NoMinerAdapter();
  }
}
