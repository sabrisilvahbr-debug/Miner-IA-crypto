// Montagem da aplicação: armazenamento, barramento, Guardião, adaptadores, gateway de LLM e runtime dos agentes.
import { MiningStateMachine, type Transition } from './mining/state.ts';
import type { ProcessSupervisor } from './mining/process.ts';
import { GpuMonitor } from './gpu/monitor.ts';
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
  gpuMonitor?: GpuMonitor;
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
  // Na suíte de testes, o nvidia-smi nunca é executado: o monitor responde "ausente" a menos que o teste injete outro.
  const gpu = opts.gpuMonitor ?? (config.appEnv === 'test'
    ? new GpuMonitor({ now, runner: async () => { throw Object.assign(new Error('nvidia-smi não executado em testes'), { code: 'ENOENT' }); } })
    : new GpuMonitor({ smiPath: config.nvidiaSmiPath, now }));
  // Estado da mineração: sempre começa DESATIVADA; transições ficam no histórico e viram eventos auditáveis.
  const mining = new MiningStateMachine({
    now,
    previous: store.getKV<Transition[]>('mining.transitions', []),
    onChange: (t) => {
      const hist = [...store.getKV<Transition[]>('mining.transitions', []), t].slice(-100);
      store.setKV('mining.transitions', hist, now());
      bus.publish({ type: 'mining.state', severity: t.to === 'ERRO' ? 'warn' : 'info', message: `Mineração: ${t.from} → ${t.to} (${t.origem}): ${t.motivo}`, data: { from: t.from, to: t.to, origem: t.origem } });
    },
  });
  const llm = new LlmGateway(store, config, now, opts.llmTransport);
  const runtime = new Runtime({ config, store, bus, guardian, logger, now });
  runtime.services = {
    store, bus, guardian, limiter, http, miner: new MinerService(adapter, 5000, now), llm, runtime, gpu, ...ext, ...opts.overrides,
  } as Services;
  runtime.register(opts.agents ?? ALL_AGENTS);
  return { config, store, bus, guardian, limiter, http, llm, runtime, logger, luxor, gpu, mining, supervisor: undefined as ProcessSupervisor | undefined };
}

export type App = ReturnType<typeof createApp>;
