// WhatToMine — SOMENTE LEITURA. Endpoint público verificado em 2026-10-29: GET https://whattomine.com/coins.json
// (respondeu sem chave). Não presume que esse acesso continue gratuito: falhas viram "indisponível".
// Campos usados: tag, algorithm, block_time, block_reward, nethash, exchange_rate, exchange_rate_curr, lagging, timestamp.
import type { HttpClient } from '../core/rateLimiter.ts';

export const WTM_COINS_URL = 'https://whattomine.com/coins.json';

export interface WtmCoin {
  name: string; // chave da entrada no JSON (ex.: "Pearl")
  id: number;
  tag: string;
  algorithm: string;
  blockTimeS: number;
  blockReward: number;
  nethash: number; // unidade não documentada pela WhatToMine
  exchangeRateBtc: number; // preço de 1 moeda em BTC
  lagging: boolean;
  timestampMs: number; // momento do dado, segundo a WhatToMine
}

export interface WtmParseResult {
  coins: WtmCoin[];
  rejected: string[]; // entradas fora do formato esperado (não usadas)
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numLike = (v: unknown): number | undefined => {
  if (isNum(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
};

/** Valida a resposta de coins.json. Entrada fora do formato é descartada e listada em "rejected", nunca corrigida. */
export function parseWtmCoins(json: unknown): WtmParseResult {
  if (!json || typeof json !== 'object' || !('coins' in json)) throw new Error('resposta da WhatToMine sem o campo "coins"');
  const raw = (json as { coins: unknown }).coins;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('campo "coins" da WhatToMine com formato inesperado');
  const coins: WtmCoin[] = [];
  const rejected: string[] = [];
  for (const [name, e] of Object.entries(raw as Record<string, unknown>)) {
    const o = (e ?? {}) as Record<string, unknown>;
    const blockTimeS = numLike(o.block_time);
    const ok =
      typeof o.tag === 'string' && o.tag.length > 0 && o.tag.length <= 20 &&
      typeof o.algorithm === 'string' && o.algorithm.length > 0 &&
      isNum(o.id) && blockTimeS !== undefined && blockTimeS > 0 &&
      isNum(o.block_reward) && o.block_reward > 0 &&
      isNum(o.nethash) && o.nethash > 0 &&
      isNum(o.exchange_rate) && o.exchange_rate > 0 && o.exchange_rate_curr === 'BTC' &&
      typeof o.lagging === 'boolean' && isNum(o.timestamp) && o.timestamp > 0;
    if (!ok) {
      if (rejected.length < 50) rejected.push(name.slice(0, 40));
      continue;
    }
    coins.push({
      name: name.slice(0, 60),
      id: o.id as number,
      tag: (o.tag as string).toUpperCase(),
      algorithm: o.algorithm as string,
      blockTimeS: blockTimeS!,
      blockReward: o.block_reward as number,
      nethash: o.nethash as number,
      exchangeRateBtc: o.exchange_rate as number,
      lagging: o.lagging as boolean,
      timestampMs: (o.timestamp as number) * 1000,
    });
  }
  return { coins, rejected };
}

export type WtmState =
  | { ok: true; coins: WtmCoin[]; rejected: number; fetchedAt: number }
  | { ok: false; reason: string; at: number };

/** Fonte com cache (padrão 5 min, igual ao intervalo de reavaliação) para não consultar a WhatToMine a cada requisição. */
export class WhatToMineSource {
  private http: HttpClient;
  private now: () => number;
  private cacheMs: number;
  private url: string;
  private last?: WtmState;
  private inflight?: Promise<WtmState>;

  constructor(http: HttpClient, now: () => number = Date.now, cacheMs = 5 * 60_000, url = WTM_COINS_URL) {
    this.http = http;
    this.now = now;
    this.cacheMs = cacheMs;
    this.url = url;
  }

  state(): WtmState | undefined {
    return this.last;
  }

  async coins(force = false): Promise<WtmState> {
    if (!force && this.last) {
      const at = this.last.ok ? this.last.fetchedAt : this.last.at;
      if (this.now() - at < this.cacheMs) return this.last;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.fetch().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetch(): Promise<WtmState> {
    try {
      const json = await this.http.getJson<unknown>(this.url, { timeoutMs: 10_000 });
      const r = parseWtmCoins(json);
      if (r.coins.length === 0) this.last = { ok: false, reason: 'WhatToMine respondeu, mas nenhuma moeda passou na validação', at: this.now() };
      else this.last = { ok: true, coins: r.coins, rejected: r.rejected.length, fetchedAt: this.now() };
    } catch (e) {
      this.last = { ok: false, reason: `WhatToMine indisponível: ${(e as Error).message.slice(0, 160)}`, at: this.now() };
    }
    return this.last;
  }
}
