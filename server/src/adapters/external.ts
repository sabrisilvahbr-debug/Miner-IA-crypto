// Adaptadores de mercado (Coinbase, público), rede Bitcoin e carteira (mempool.space, público) e pool (JSON configurável).
// Todos são SOMENTE LEITURA: nenhum adaptador movimenta fundos.
import type { Provenance } from '../core/types.ts';
import type { HttpClient } from '../core/rateLimiter.ts';
import { DisconnectedError } from '../core/rateLimiter.ts';
import type { AppConfig } from '../config.ts';
import { SIM_EPOCH, wave } from './sim.ts';

export interface Quote { pair: string; price: number; provenance: Provenance; source: string }
export interface NetworkInfo {
  height?: number;
  difficulty?: number;
  networkHashrateHs?: number;
  difficultyChangePct?: number;
  remainingBlocks?: number;
  retargetEta?: number;
  provenance: Provenance;
  source: string;
}
export interface Fees { fastest: number; halfHour: number; hour: number; economy: number; provenance: Provenance; source: string }
export interface PoolStats { balance?: number; paidTotal?: number; hashrateHs?: number; provenance: Provenance; source: string }
export interface WalletInfo {
  address: string;
  confirmedBalanceSat: number;
  receivedSat: number;
  unconfirmedSat: number;
  txCount: number;
  provenance: Provenance;
  source: string;
}

export interface MarketAdapter { readonly provenance: Provenance; quote(pair: string): Promise<Quote> }
export interface NetworkAdapter { readonly provenance: Provenance; info(): Promise<NetworkInfo>; fees(): Promise<Fees> }
export interface PoolAdapter { readonly provenance: Provenance; stats(): Promise<PoolStats> }
export interface WalletAdapter { readonly provenance: Provenance; info(): Promise<WalletInfo> }

const unavailable = (what: string) => new DisconnectedError(`${what} não configurado`);

// ---------------- Mercado ----------------
export class CoinbaseMarket implements MarketAdapter {
  readonly provenance: Provenance = 'real';
  private http: HttpClient;
  constructor(http: HttpClient) { this.http = http; }
  async quote(pair: string): Promise<Quote> {
    if (!/^[A-Z0-9]{2,10}-[A-Z]{3,5}$/.test(pair)) throw new Error(`par inválido: ${pair}`);
    const d = await this.http.getJson<{ data?: { amount?: string } }>(`https://api.coinbase.com/v2/prices/${pair}/spot`);
    const price = Number(d?.data?.amount);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`cotação inválida para ${pair}`);
    return { pair, price, provenance: 'real', source: 'coinbase' };
  }
}

export class SimulatedMarket implements MarketAdapter {
  readonly provenance: Provenance = 'simulado';
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  async quote(pair: string): Promise<Quote> {
    const t = this.now();
    const usd = 100_000 * (1 + wave(t, 6 * 3_600_000, 1) * 0.04 + wave(t, 900_000, 3) * 0.004);
    const fx: Record<string, number> = { USD: 1, BRL: 5.5, EUR: 0.92 };
    const [base, quote] = pair.split('-');
    const baseUsd = base === 'BTC' ? usd : base === 'ETH' ? usd * 0.035 : usd * 0.002;
    return { pair, price: Math.round(baseUsd * (fx[quote] ?? 1) * 100) / 100, provenance: 'simulado', source: 'simulador' };
  }
}

export class NoMarket implements MarketAdapter {
  readonly provenance: Provenance = 'real';
  async quote(): Promise<Quote> { throw unavailable('mercado'); }
}

// ---------------- Rede Bitcoin ----------------
export class MempoolNetwork implements NetworkAdapter {
  readonly provenance: Provenance = 'real';
  private http: HttpClient;
  private base: string;
  constructor(http: HttpClient, base = 'https://mempool.space') { this.http = http; this.base = base; }
  async info(): Promise<NetworkInfo> {
    const height = await this.http.getJson<number>(`${this.base}/api/blocks/tip/height`);
    const adj = await this.http.getJson<Record<string, number>>(`${this.base}/api/v1/difficulty-adjustment`);
    const hr = await this.http.getJson<Record<string, number>>(`${this.base}/api/v1/mining/hashrate/3d`);
    return {
      height: Number(height),
      difficulty: Number(hr?.currentDifficulty) || undefined,
      networkHashrateHs: Number(hr?.currentHashrate) || undefined,
      difficultyChangePct: Number(adj?.difficultyChange),
      remainingBlocks: Number(adj?.remainingBlocks),
      retargetEta: Number(adj?.estimatedRetargetDate) || undefined,
      provenance: 'real',
      source: 'mempool.space',
    };
  }
  async fees(): Promise<Fees> {
    const f = await this.http.getJson<Record<string, number>>(`${this.base}/api/v1/fees/recommended`);
    return { fastest: f.fastestFee, halfHour: f.halfHourFee, hour: f.hourFee, economy: f.economyFee, provenance: 'real', source: 'mempool.space' };
  }
}

export class SimulatedNetwork implements NetworkAdapter {
  readonly provenance: Provenance = 'simulado';
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  async info(): Promise<NetworkInfo> {
    const t = this.now();
    const height = 930_000 + Math.floor((t - SIM_EPOCH) / 600_000);
    return {
      height,
      difficulty: 1.4e14 * (1 + Math.floor((height - 930_000) / 2016) * 0.01),
      networkHashrateHs: 1.0e21 * (1 + wave(t, 86_400_000, 2) * 0.03),
      difficultyChangePct: Math.round(wave(t, 86_400_000 * 3, 5) * 400) / 100,
      remainingBlocks: 2016 - (height % 2016),
      retargetEta: t + (2016 - (height % 2016)) * 600_000,
      provenance: 'simulado',
      source: 'simulador',
    };
  }
  async fees(): Promise<Fees> {
    const b = 6 + wave(this.now(), 3_600_000, 4) * 4;
    return { fastest: Math.round(b * 2), halfHour: Math.round(b * 1.5), hour: Math.round(b), economy: Math.max(1, Math.round(b / 2)), provenance: 'simulado', source: 'simulador' };
  }
}

export class NoNetwork implements NetworkAdapter {
  readonly provenance: Provenance = 'real';
  async info(): Promise<NetworkInfo> { throw unavailable('fonte de rede'); }
  async fees(): Promise<Fees> { throw unavailable('fonte de rede'); }
}

// ---------------- Pool ----------------
export function readPath(obj: unknown, path?: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[/^\d+$/.test(part) ? Number(part) : part];
  }
  return cur;
}

/** Pool genérica: lê um endpoint JSON da pool e extrai campos por caminho (ex.: "data.balance"). */
export class JsonPool implements PoolAdapter {
  readonly provenance: Provenance = 'real';
  private http: HttpClient;
  private c: AppConfig;
  constructor(http: HttpClient, c: AppConfig) { this.http = http; this.c = c; }
  async stats(): Promise<PoolStats> {
    if (!this.c.poolStatsUrl) throw unavailable('POOL_STATS_URL');
    const d = await this.http.getJson(this.c.poolStatsUrl);
    const numOrU = (v: unknown) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? undefined : Number(v));
    return {
      balance: numOrU(readPath(d, this.c.poolBalancePath)),
      paidTotal: numOrU(readPath(d, this.c.poolPaidPath)),
      hashrateHs: numOrU(readPath(d, this.c.poolHashratePath)),
      provenance: 'real',
      source: new URL(this.c.poolStatsUrl).host,
    };
  }
}

export class SimulatedPool implements PoolAdapter {
  readonly provenance: Provenance = 'simulado';
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  async stats(): Promise<PoolStats> {
    const t = this.now();
    const days = (t - SIM_EPOCH) / 86_400_000;
    const perDay = 0.00035; // BTC/dia simulado
    const paidTotal = Math.floor(days / 7) * perDay * 7;
    return {
      balance: Math.round((days * perDay - paidTotal) * 1e8) / 1e8,
      paidTotal: Math.round(paidTotal * 1e8) / 1e8,
      hashrateHs: 108e12 * (1 + wave(t, 1_200_000, 6) * 0.04),
      provenance: 'simulado',
      source: 'simulador',
    };
  }
}

export class NoPool implements PoolAdapter {
  readonly provenance: Provenance = 'real';
  async stats(): Promise<PoolStats> { throw unavailable('pool'); }
}

// ---------------- Carteira (somente leitura) ----------------
export class MempoolWallet implements WalletAdapter {
  readonly provenance: Provenance = 'real';
  private http: HttpClient;
  private address?: string;
  private base: string;
  constructor(http: HttpClient, address?: string, base = 'https://mempool.space') {
    this.http = http;
    this.address = address;
    this.base = base;
  }
  async info(): Promise<WalletInfo> {
    if (!this.address) throw unavailable('WALLET_BTC_ADDRESS');
    if (!/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,87}$/.test(this.address)) throw new Error('endereço Bitcoin em formato inválido');
    const d = await this.http.getJson<Record<string, Record<string, number>>>(`${this.base}/api/address/${this.address}`);
    const cs = d.chain_stats ?? {};
    const ms = d.mempool_stats ?? {};
    return {
      address: this.address,
      receivedSat: cs.funded_txo_sum ?? 0,
      confirmedBalanceSat: (cs.funded_txo_sum ?? 0) - (cs.spent_txo_sum ?? 0),
      unconfirmedSat: (ms.funded_txo_sum ?? 0) - (ms.spent_txo_sum ?? 0),
      txCount: cs.tx_count ?? 0,
      provenance: 'real',
      source: 'mempool.space',
    };
  }
}

export class SimulatedWallet implements WalletAdapter {
  readonly provenance: Provenance = 'simulado';
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  async info(): Promise<WalletInfo> {
    const weeks = Math.floor((this.now() - SIM_EPOCH) / (7 * 86_400_000));
    const received = Math.round(weeks * 0.00035 * 7 * 1e8);
    return {
      address: 'bc1qsimulado000000000000000000000000000000',
      receivedSat: received,
      confirmedBalanceSat: received,
      unconfirmedSat: 0,
      txCount: weeks,
      provenance: 'simulado',
      source: 'simulador',
    };
  }
}

export class NoWallet implements WalletAdapter {
  readonly provenance: Provenance = 'real';
  async info(): Promise<WalletInfo> { throw unavailable('carteira'); }
}

export function createExternalAdapters(c: AppConfig, http: HttpClient, now: () => number) {
  // Defesa extra: adaptadores simulados só existem na suíte de testes (APP_ENV=test).
  if (c.appEnv !== 'test' && [c.marketSource, c.networkSource, c.poolSource, c.walletSource].includes('simulated')) {
    throw new Error('fonte simulada recusada fora do ambiente de testes');
  }
  return {
    market: c.marketSource === 'coinbase' ? new CoinbaseMarket(http) : c.marketSource === 'simulated' ? new SimulatedMarket(now) : new NoMarket(),
    network: c.networkSource === 'mempool' ? new MempoolNetwork(http) : c.networkSource === 'simulated' ? new SimulatedNetwork(now) : new NoNetwork(),
    pool: (c.poolSource === 'json' ? new JsonPool(http, c) : c.poolSource === 'simulated' ? new SimulatedPool(now) : new NoPool()) as PoolAdapter, // 'luxor' é montada em app.ts
    wallet: c.walletSource === 'mempool' ? new MempoolWallet(http, c.walletBtcAddress) : c.walletSource === 'simulated' ? new SimulatedWallet(now) : new NoWallet(),
  };
}
