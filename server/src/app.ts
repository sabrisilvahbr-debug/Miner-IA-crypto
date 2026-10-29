// Montagem da aplicação: armazenamento, barramento, Guardião, adaptadores, gateway de LLM e runtime dos agentes.
import type { AppConfig } from './config.ts';
import { Store } from './core/store.ts';
import { EventBus } from './core/eventBus.ts';
import { RiskGuardian } from './core/riskGuardian.ts';
import { RateLimiter, createHttpClient } from './core/rateLimiter.ts';
import { LlmGateway, type LlmTransport } from './core/llmGateway.ts';
import { Runtime } from './core/runtime.ts';
import { createLogger, type Logger } from './core/logger.ts';
import { MinerService, createMinerAdapter, type MinerAdapter } from './adapters/miner.ts';
import { createExternalAdapters } from './adapters/external.ts';
import { LuxorClient, LuxorPool, type LuxorValidation } from './adapters/luxor.ts';
import { ALL_AGENTS } from './agents/index.ts';
import type { AgentDefinition } from './core/types.ts';
import type { Services } from './core/services.ts';

export interface AppOptions {
  now?: () => number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  minerAdapter?: MinerAdapter;
  llmTransport?: LlmTransport;
  agents?: AgentDefinition[];
  overrides?: Partial<Omit<Services, 'runtime'>>;
}

export function createApp(config: AppConfig, opts: AppOptions = {}) {
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? createLogger({ app: 'office50' });
  const store = new Store(config.dbPath);
  const bus = new EventBus(store, logger, now);
  const guardian = new RiskGuardian(store, config, now);
  const limiter = new RateLimiter(config.externalCallsPerMinute, now);
  const http = createHttpClient(limiter, opts.fetchImpl);
  const adapter = opts.minerAdapter ?? createMinerAdapter(config, http, now);
  guardian.minerProvenance = adapter.provenance;
  const ext = createExternalAdapters(config, http, now);
  let luxor: LuxorPool | undefined;
  if (config.poolSource === 'luxor') {
    const client = new LuxorClient({ baseUrl: config.luxorApiUrl, apiKey: config.luxorApiKey, fetchImpl: opts.fetchImpl, limiter });
    luxor = new LuxorPool(client, config, {
      now,
      initial: store.getKV<LuxorValidation | undefined>('luxor.validation', undefined),
      onValidation: (v) => {
        const prev = store.getKV<LuxorValidation | undefined>('luxor.validation', undefined);
        store.setKV('luxor.validation', v, now());
        if (prev?.state !== v.state || prev?.dataVerified !== v.dataVerified) {
          bus.publish({ type: 'pool.luxor_validation', severity: v.state === 'validada' ? 'info' : 'warn', message: `Luxor: ${v.state}${v.dataVerified ? ' (dados conferidos)' : ''} · ${v.message}`, data: { state: v.state, httpStatus: v.httpStatus } });
        }
      },
    });
    ext.pool = luxor;
  }
  const llm = new LlmGateway(store, config, now, opts.llmTransport);
  const runtime = new Runtime({ config, store, bus, guardian, logger, now });
  runtime.services = {
    store, bus, guardian, limiter, http, miner: new MinerService(adapter, 5000, now), llm, runtime, ...ext, ...opts.overrides,
  } as Services;
  runtime.register(opts.agents ?? ALL_AGENTS);
  return { config, store, bus, guardian, limiter, http, llm, runtime, logger, luxor };
}

export type App = ReturnType<typeof createApp>;
