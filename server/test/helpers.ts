import { createApp, type AppOptions } from '../src/app.ts';
import { testConfig } from '../src/config.ts';
import type { AppConfig } from '../src/config.ts';
import { silentLogger } from '../src/core/logger.ts';
import type { AgentDefinition, AgentResult, AgentContext } from '../src/core/types.ts';

export function makeApp(overrides: Partial<AppConfig> = {}, opts: AppOptions = {}) {
  return createApp(testConfig(overrides), { logger: silentLogger, ...opts });
}

export function fakeAgent(id: number, run: (ctx: AgentContext) => Promise<AgentResult>, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    code: `T${id}`,
    name: `Teste ${id}`,
    department: 1,
    responsibility: 'teste',
    mode: 'scheduled',
    intervalMs: 60_000,
    permissions: ['write:metrics', 'emit:alert', 'propose:action'],
    inputs: ['x'],
    outputs: ['y'],
    maturity: 'validado',
    run,
    ...extra,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
