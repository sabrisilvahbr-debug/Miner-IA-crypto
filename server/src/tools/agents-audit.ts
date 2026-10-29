// Gera docs/AUDITORIA-AGENTES.md a partir das definições reais dos 50 agentes: npm run audit:agents
// A classificação vem do campo "maturity" e das dependências de cada agente. A última execução e o
// resultado de cada agente só existem em tempo de execução: consulte GET /api/agents/:id no painel.
import { writeFileSync } from 'node:fs';
import { ALL_AGENTS, DEPARTMENTS } from '../agents/index.ts';
import type { AgentDefinition } from '../core/types.ts';

const CLASS: Record<string, string> = {
  validado: 'IMPLEMENTADO E TESTADO',
  simulado: 'IMPLEMENTADO, MAS NÃO VALIDADO',
  stub: 'PARCIALMENTE IMPLEMENTADO',
};

const SOURCES: Record<string, string> = {
  'read:miner': 'minerador (XMRig/cgminer) e GPU (nvidia-smi)',
  'read:market': 'Coinbase e mempool.space',
  'read:pool': 'pool (Luxor ou JSON)',
  'read:wallet': 'mempool.space (endereço público)',
  'call:llm': 'API Anthropic (opcional)',
  'read:metrics': 'métricas gravadas por outros agentes',
};

/** Agentes que dependem de hardware/conta que ainda não existem: código testado, mas sem dado real hoje. */
function availability(a: AgentDefinition): string {
  const p = a.permissions;
  if (p.includes('read:miner') && a.id !== 14) return 'INDISPONÍVEL até haver minerador integrado';
  if (a.id === 14) return 'depende do nvidia-smi no Windows (HARDWARE NÃO VERIFICADO pelo sistema)';
  if (p.includes('read:pool')) return 'INDISPONÍVEL até a Luxor ser validada com a sua chave';
  if (p.includes('read:wallet')) return 'desligado (WALLET_SOURCE=none, escolha do operador)';
  if (p.includes('call:llm')) return 'desligado (LLM_ENABLED=false)';
  if (p.includes('read:market')) return 'depende de MARKET_SOURCE=coinbase / NETWORK_SOURCE=mempool; não testado ao vivo no ambiente de desenvolvimento';
  return 'funciona com os dados disponíveis';
}

const esc = (s: string) => s.replace(/\|/g, '\\|');

const lines: string[] = [];
lines.push('# Auditoria dos 50 agentes', '');
lines.push('Gerado por `npm run audit:agents` a partir do código. Não edite à mão.', '');
lines.push('**Como ler a classificação:**');
lines.push('- **IMPLEMENTADO E TESTADO**: lógica coberta por testes automatizados e sem dependência de hardware ou conta externa.');
lines.push('- **IMPLEMENTADO, MAS NÃO VALIDADO**: o código existe e passa nos testes com dados de teste, mas nunca rodou com o equipamento ou a conta real.');
lines.push('- **PARCIALMENTE IMPLEMENTADO**: esboço.');
lines.push('');
lines.push('Os agentes são módulos coordenados por um único runtime (não são 50 processos). Nenhum agente executa mineração. Última execução, resultado e erros de cada um ficam em `GET /api/agents/:id` e na ficha do agente no painel.', '');

const counts: Record<string, number> = {};
for (const a of ALL_AGENTS) counts[CLASS[a.maturity] ?? a.maturity] = (counts[CLASS[a.maturity] ?? a.maturity] ?? 0) + 1;
lines.push('| Classificação | Agentes |', '|---|---|');
for (const [k, v] of Object.entries(counts)) lines.push(`| ${k} | ${v} |`);
lines.push('');

for (const d of DEPARTMENTS) {
  const list = ALL_AGENTS.filter((a) => a.department === d.id);
  lines.push(`## ${d.id}. ${d.name}`, '');
  lines.push('| # | Agente | Função | Entradas | Saídas | Ferramentas e fontes | Classificação | Disponibilidade hoje |', '|---|---|---|---|---|---|---|---|');
  for (const a of list) {
    const tools = a.permissions.map((p) => SOURCES[p] ?? p).filter((v, i, arr) => arr.indexOf(v) === i).join('; ');
    lines.push(`| ${a.id} | **${esc(a.name)}** (${a.code}) | ${esc(a.responsibility)} | ${esc(a.inputs.join(', '))} | ${esc(a.outputs.join(', '))} | ${esc(tools)} | ${CLASS[a.maturity] ?? a.maturity} | ${availability(a)} |`);
  }
  lines.push('');
}

const out = process.argv[2] ?? 'docs/AUDITORIA-AGENTES.md';
writeFileSync(out, lines.join('\n'));
console.log(`${ALL_AGENTS.length} agentes auditados → ${out}`);
