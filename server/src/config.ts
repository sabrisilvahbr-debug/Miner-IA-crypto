// Configuração lida de variáveis de ambiente (ou de um arquivo .env simples).
// Nenhum segredo é registrado em log; veja o agente 27 (Cofre de Credenciais).
import { existsSync, readFileSync } from 'node:fs';

export type MinerType = 'simulated' | 'xmrig' | 'cgminer' | 'none';
export type SourceMode = 'simulated' | 'real' | 'none';

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  dataDir: string;
  apiToken?: string;

  marketSource: 'simulated' | 'coinbase' | 'none';
  pricePairs: string[];
  networkSource: 'simulated' | 'mempool' | 'none';

  minerType: MinerType;
  minerUrl?: string; // xmrig: http://127.0.0.1:8080 ; cgminer: tcp://192.168.0.50:4028
  minerAccessToken?: string;
  minerAlgo: string; // sha256d | randomx | ...

  poolSource: 'simulated' | 'json' | 'luxor' | 'none';
  luxorApiUrl: string;
  luxorApiKey?: string; // segredo: só no backend, nunca enviado ao navegador
  luxorCurrency: 'BTC' | 'LTC_DOGE' | 'SC' | 'ZEC';
  luxorSubaccount?: string;
  luxorSiteId?: string;
  luxorWorkerName?: string;
  poolStatsUrl?: string;
  poolBalancePath?: string;
  poolPaidPath?: string;
  poolHashratePath?: string;
  poolStratumUrl?: string;
  allowedPools: string[];

  walletSource: 'simulated' | 'mempool' | 'none';
  walletBtcAddress?: string;
  allowedWallets: string[];

  powerWatts?: number;
  nvidiaSmiPath?: string; // opcional: caminho absoluto do nvidia-smi (somente leitura)
  miningDataSource: 'whattomine' | 'none'; // fonte de rentabilidade das moedas de GPU
  miningDataMaxAgeMin: number; // dado mais velho que isso não entra no cálculo
  gpuHashrates: Record<string, number>; // GPU_HASHRATE_<SIGLA>, mesma unidade do nethash da WhatToMine
  energyPriceKwh?: number; // moeda local (BRL)
  localCurrency: string;

  maxTempC: number;
  criticalTempC: number;
  maxRejectRatePct: number;
  maxRestartsPerHour: number;
  maxActionsPerHour: number;
  minMinerVersion?: string;

  maxConcurrency: number;
  taskTimeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  externalCallsPerMinute: number;

  llmEnabled: boolean;
  anthropicApiKey?: string;
  llmModel: string;
  llmMaxCallsPerDay: number;
  llmMaxTokensPerMonth: number;

  telegramBotToken?: string;
  telegramChatId?: string;

  retentionDays: number;
  autostart: boolean;
}

/** Lê um .env simples: CHAVE=valor, aspas opcionais e comentários (# no início ou no fim da linha). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/(^|\s+)#.*$/, '').trim(); // comentário no fim da linha (ou campo vazio com comentário)
    out[m[1]] = value;
  }
  return out;
}

function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const [k, v] of Object.entries(parseDotEnv(readFileSync(path, 'utf8')))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const str = (env: NodeJS.ProcessEnv, k: string): string | undefined => {
  const v = env[k];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};
const num = (env: NodeJS.ProcessEnv, k: string, d: number): number => {
  const v = str(env, k);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const optNum = (env: NodeJS.ProcessEnv, k: string): number | undefined => {
  const v = str(env, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const list = (env: NodeJS.ProcessEnv, k: string, d: string[] = []): string[] => {
  const v = str(env, k);
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d;
};
const bool = (env: NodeJS.ProcessEnv, k: string, d: boolean): boolean => {
  const v = str(env, k);
  return v === undefined ? d : ['1', 'true', 'sim', 'yes'].includes(v.toLowerCase());
};
function oneOf<T extends string>(env: NodeJS.ProcessEnv, k: string, allowed: readonly T[], d: T): T {
  const v = str(env, k) as T | undefined;
  return v && allowed.includes(v) ? v : d;
}

/** Lê GPU_HASHRATE_<SIGLA>=<número positivo>. Valores inválidos são ignorados (nunca viram zero). */
export function gpuHashrates(env: NodeJS.ProcessEnv): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^GPU_HASHRATE_([A-Z0-9]{2,12})$/.exec(k);
    if (!m || v === undefined) continue;
    const t = v.trim();
    if (!/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) continue;
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) out[m[1]] = n;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, useDotEnv = true): AppConfig {
  if (useDotEnv) loadDotEnv();
  const dataDir = str(env, 'DATA_DIR') ?? 'data';
  return {
    host: str(env, 'HOST') ?? '127.0.0.1',
    port: num(env, 'PORT', 8050),
    dataDir,
    dbPath: str(env, 'DB_PATH') ?? `${dataDir}/office50.db`,
    apiToken: str(env, 'API_TOKEN'),

    marketSource: oneOf(env, 'MARKET_SOURCE', ['simulated', 'coinbase', 'none'] as const, 'simulated'),
    pricePairs: list(env, 'PRICE_PAIRS', ['BTC-USD', 'BTC-BRL']),
    networkSource: oneOf(env, 'NETWORK_SOURCE', ['simulated', 'mempool', 'none'] as const, 'simulated'),

    minerType: oneOf(env, 'MINER_TYPE', ['simulated', 'xmrig', 'cgminer', 'none'] as const, 'simulated'),
    minerUrl: str(env, 'MINER_URL'),
    minerAccessToken: str(env, 'MINER_ACCESS_TOKEN'),
    minerAlgo: str(env, 'MINER_ALGO') ?? 'sha256d',

    poolSource: oneOf(env, 'POOL_SOURCE', ['simulated', 'json', 'luxor', 'none'] as const, 'simulated'),
    luxorApiUrl: (str(env, 'LUXOR_API_URL') ?? 'https://app.luxor.tech/api/v2').replace(/\/$/, ''),
    luxorApiKey: str(env, 'LUXOR_API_KEY'),
    luxorCurrency: oneOf(env, 'LUXOR_CURRENCY', ['BTC', 'LTC_DOGE', 'SC', 'ZEC'] as const, 'BTC'),
    luxorSubaccount: str(env, 'LUXOR_SUBACCOUNT'),
    luxorSiteId: str(env, 'LUXOR_SITE_ID'),
    luxorWorkerName: str(env, 'LUXOR_WORKER_NAME'),
    poolStatsUrl: str(env, 'POOL_STATS_URL'),
    poolBalancePath: str(env, 'POOL_BALANCE_PATH'),
    poolPaidPath: str(env, 'POOL_PAID_PATH'),
    poolHashratePath: str(env, 'POOL_HASHRATE_PATH'),
    poolStratumUrl: str(env, 'POOL_STRATUM_URL'),
    allowedPools: list(env, 'ALLOWED_POOLS'),

    walletSource: oneOf(env, 'WALLET_SOURCE', ['simulated', 'mempool', 'none'] as const, 'simulated'),
    walletBtcAddress: str(env, 'WALLET_BTC_ADDRESS'),
    allowedWallets: list(env, 'ALLOWED_WALLETS'),

    powerWatts: optNum(env, 'POWER_WATTS'),
    nvidiaSmiPath: str(env, 'NVIDIA_SMI_PATH'),
    miningDataSource: oneOf(env, 'MINING_DATA_SOURCE', ['whattomine', 'none'] as const, 'none'),
    miningDataMaxAgeMin: num(env, 'MINING_DATA_MAX_AGE_MIN', 15),
    gpuHashrates: gpuHashrates(env),
    energyPriceKwh: optNum(env, 'ENERGY_PRICE_KWH'),
    localCurrency: str(env, 'LOCAL_CURRENCY') ?? 'BRL',

    maxTempC: num(env, 'MAX_TEMP_C', 80),
    criticalTempC: num(env, 'CRITICAL_TEMP_C', 90),
    maxRejectRatePct: num(env, 'MAX_REJECT_RATE_PCT', 5),
    maxRestartsPerHour: num(env, 'MAX_RESTARTS_PER_HOUR', 3),
    maxActionsPerHour: num(env, 'MAX_ACTIONS_PER_HOUR', 10),
    minMinerVersion: str(env, 'MIN_MINER_VERSION'),

    maxConcurrency: num(env, 'MAX_CONCURRENCY', 4),
    taskTimeoutMs: num(env, 'TASK_TIMEOUT_MS', 15000),
    maxRetries: num(env, 'MAX_RETRIES', 2),
    retryBaseMs: num(env, 'RETRY_BASE_MS', 500),
    externalCallsPerMinute: num(env, 'EXTERNAL_CALLS_PER_MINUTE', 30),

    llmEnabled: bool(env, 'LLM_ENABLED', false),
    anthropicApiKey: str(env, 'ANTHROPIC_API_KEY'),
    llmModel: str(env, 'LLM_MODEL') ?? 'claude-haiku-5-5',
    llmMaxCallsPerDay: num(env, 'LLM_MAX_CALLS_PER_DAY', 10),
    llmMaxTokensPerMonth: num(env, 'LLM_MAX_TOKENS_PER_MONTH', 200000),

    telegramBotToken: str(env, 'TELEGRAM_BOT_TOKEN'),
    telegramChatId: str(env, 'TELEGRAM_CHAT_ID'),

    retentionDays: num(env, 'RETENTION_DAYS', 30),
    autostart: bool(env, 'AUTOSTART', true),
  };
}

/** Configuração para testes: tudo simulado, sem rede, rápido. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({}, false),
    dbPath: ':memory:',
    dataDir: 'data-test',
    retryBaseMs: 1,
    taskTimeoutMs: 1000,
    autostart: false,
    ...overrides,
  };
}

export function isSimulatedSetup(c: AppConfig): boolean {
  return c.minerType === 'simulated' || c.poolSource === 'simulated' || c.walletSource === 'simulated';
}
