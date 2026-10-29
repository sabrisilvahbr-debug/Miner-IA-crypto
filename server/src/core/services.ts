// Serviços compartilhados entregues aos agentes, com acesso limitado pelas permissões declaradas.
import type { Store } from './store.ts';
import type { EventBus } from './eventBus.ts';
import type { RiskGuardian } from './riskGuardian.ts';
import type { RateLimiter, HttpClient } from './rateLimiter.ts';
import type { LlmGateway } from './llmGateway.ts';
import type { MinerService } from '../adapters/miner.ts';
import type { MarketAdapter, NetworkAdapter, PoolAdapter, WalletAdapter } from '../adapters/external.ts';
import type { AgentDefinition, AgentRuntimeInfo, Permission, TaskRecord } from './types.ts';

export class PermissionError extends Error {
  constructor(agent: string, perm: Permission) {
    super(`agente ${agent} não possui a permissão ${perm}`);
    this.name = 'PermissionError';
  }
}

export interface RuntimeView {
  startedAt: number;
  agents(): AgentRuntimeInfo[];
  agent(id: number): AgentRuntimeInfo | undefined;
  definitions(): AgentDefinition[];
  queueStats(): { queued: number; running: number; maxConcurrency: number; duplicatesSkipped: number };
  stuckTasks(olderThanMs: number): TaskRecord[];
  failTask(id: string, reason: string): void;
  setCooldown(agentId: number, untilTs: number): void;
  clientCount(): number;
}

export interface Services {
  store: Store;
  bus: EventBus;
  guardian: RiskGuardian;
  limiter: RateLimiter;
  http: HttpClient;
  miner: MinerService;
  market: MarketAdapter;
  network: NetworkAdapter;
  pool: PoolAdapter;
  wallet: WalletAdapter;
  llm: LlmGateway;
  runtime: RuntimeView;
}

const GATES: Partial<Record<keyof Services, Permission>> = {
  miner: 'read:miner',
  market: 'read:market',
  network: 'read:market',
  pool: 'read:pool',
  wallet: 'read:wallet',
  llm: 'call:llm',
  runtime: 'read:runtime',
};

/** Cria uma visão dos serviços em que o acesso a cada adaptador exige a permissão correspondente. */
export function scopeServices(all: Services, def: Pick<AgentDefinition, 'code' | 'permissions'>): Services {
  const scoped = {} as Services;
  for (const key of Object.keys(all) as (keyof Services)[]) {
    const perm = GATES[key];
    Object.defineProperty(scoped, key, {
      enumerable: true,
      get() {
        if (perm && !def.permissions.includes(perm)) throw new PermissionError(def.code, perm);
        return all[key];
      },
    });
  }
  return scoped;
}
