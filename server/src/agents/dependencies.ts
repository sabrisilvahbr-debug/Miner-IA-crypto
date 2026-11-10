// Mapa de dependências entre os 50 agentes: de quais agentes cada um consome dados.
// Mantido em um único lugar para ser auditável; validado pelo Registro Central (A03) e pelos testes.
// Dependência aqui é de DADOS (métricas ou eventos produzidos por outro agente), não de ordem de execução:
// se a origem falha, o dependente continua rodando, mas a sua saúde passa a "atenção".
import type { AgentDefinition } from '../core/types.ts';

export const DEPENDS_ON: Record<number, number[]> = {
  1: [12, 22, 23, 42], // evidência de mineração: hashrate, shares, saldo na pool, recebimentos
  8: [7], // altura da rede
  9: [6], // histórico de preços
  12: [11], 13: [11], 14: [11], // mesma conexão com o minerador
  15: [12],
  16: [11],
  18: [6, 7, 8, 12, 16, 17],
  19: [18],
  20: [7, 18],
  22: [11],
  23: [21],
  24: [21], // pool.disconnected
  25: [11],
  26: [13, 22, 44], // temperatura, rejeição e carteira
  31: [1, 13, 18, 22],
  32: [6, 7, 8, 12, 16, 17],
  34: [18, 33], // análise usa as estimativas e o gateway de LLM
  35: [37], // histórico de ações executadas
  37: [26], // só executa o que o Guardião reavalia
  39: [11], // versão do minerador
  42: [6, 44],
  43: [23, 42],
  45: [6, 42],
  48: [47],
  49: [1],
};

/** Anexa `dependsOn` às definições (lista vazia quando o agente não consome dados de outro). */
export function withDependencies(defs: AgentDefinition[]): AgentDefinition[] {
  for (const d of defs) d.dependsOn = [...(DEPENDS_ON[d.id] ?? [])];
  return defs;
}

/** Problemas do grafo: referência inexistente, autodependência, duplicata ou ciclo. Lista vazia = grafo válido. */
export function validateDependencies(defs: Pick<AgentDefinition, 'id' | 'code' | 'dependsOn'>[]): string[] {
  const problems: string[] = [];
  const byId = new Map(defs.map((d) => [d.id, d]));
  for (const d of defs) {
    const deps = d.dependsOn ?? [];
    if (new Set(deps).size !== deps.length) problems.push(`${d.code} com dependência repetida`);
    for (const dep of deps) {
      if (dep === d.id) problems.push(`${d.code} depende de si mesmo`);
      else if (!byId.has(dep)) problems.push(`${d.code} depende do agente inexistente ${dep}`);
    }
  }
  // Ciclos: busca em profundidade com três cores.
  const color = new Map<number, 0 | 1 | 2>();
  const visit = (id: number, path: number[]): void => {
    color.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep) || dep === id) continue;
      const c = color.get(dep) ?? 0;
      if (c === 1) problems.push(`ciclo de dependências: ${[...path.slice(path.indexOf(dep)), dep].join(' → ')}`);
      else if (c === 0) visit(dep, [...path, dep]);
    }
    color.set(id, 2);
  };
  for (const d of defs) if (!color.get(d.id)) visit(d.id, [d.id]);
  return problems;
}

/** Ordem em que as origens vêm antes dos consumidores (útil para aquecer o sistema e para a interface). */
export function topologicalOrder(defs: Pick<AgentDefinition, 'id' | 'dependsOn'>[]): number[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const done = new Set<number>();
  const out: number[] = [];
  const visit = (id: number, stack: Set<number>): void => {
    if (done.has(id) || stack.has(id)) return;
    stack.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep, stack);
    stack.delete(id);
    done.add(id);
    out.push(id);
  };
  for (const d of [...defs].sort((a, b) => a.id - b.id)) visit(d.id, new Set());
  return out;
}
