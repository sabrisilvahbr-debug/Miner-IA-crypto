// Registro dos 50 agentes, organizados em 10 departamentos.
import type { AgentDefinition } from '../core/types.ts';
import { direcao } from './d01-direcao.ts';
import { mercado } from './d02-mercado.ts';
import { mineracao } from './d03-mineracao.ts';
import { energia } from './d04-energia.ts';
import { pools } from './d05-pools.ts';
import { risco } from './d06-risco.ts';
import { estrategia } from './d07-estrategia.ts';
import { automacao } from './d08-automacao.ts';
import { auditoria } from './d09-auditoria.ts';
import { comunicacao } from './d10-comunicacao.ts';

export { DEPARTMENTS } from './common.ts';

export const ALL_AGENTS: AgentDefinition[] = [
  ...direcao, ...mercado, ...mineracao, ...energia, ...pools,
  ...risco, ...estrategia, ...automacao, ...auditoria, ...comunicacao,
];
