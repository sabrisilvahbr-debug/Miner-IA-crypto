// Departamento 7 — Estratégia e inteligência artificial (agentes 31–35)
// Recomendações são determinísticas. O LLM é opcional, passa por um único gateway e tem saída validada.
import type { AgentContext, AgentDefinition } from '../core/types.ts';
import { validateAnalysis } from '../core/llmGateway.ts';
import { HOUR, MIN, asEstimate, expectedBtcPerDay, metric } from './common.ts';

function snapshotForAnalysis(ctx: AgentContext) {
  const keys = [
    'miner.hashrate_hs', 'miner.temperature_c', 'miner.reject_rate_pct', 'system.evidence_level', 'profit.revenue_day',
    'profit.energy_cost_day', 'profit.net_day', 'price.BTC-USD', 'network.difficulty_change_pct', 'pool.balance', 'risk.level',
  ];
  const data: Record<string, { valor: unknown; procedencia: string }> = {};
  for (const k of keys) {
    const m = ctx.metrics.get(k);
    if (m) data[k] = { valor: typeof m.value === 'number' ? Math.round(m.value * 1e4) / 1e4 : m.value, procedencia: m.provenance };
  }
  return data;
}

function deterministicAnalysis(data: ReturnType<typeof snapshotForAnalysis>): { resumo: string; riscos: string[] } {
  const riscos: string[] = [];
  const v = (k: string) => data[k]?.valor;
  const simulated = Object.values(data).some((d) => d.procedencia === 'simulado');
  if (typeof v('profit.net_day') === 'number' && (v('profit.net_day') as number) < 0) riscos.push('Resultado diário estimado negativo: o custo de energia supera a receita estimada.');
  if (typeof v('miner.reject_rate_pct') === 'number' && (v('miner.reject_rate_pct') as number) > 2) riscos.push('Taxa de rejeição de shares acima de 2%.');
  if (typeof v('network.difficulty_change_pct') === 'number' && (v('network.difficulty_change_pct') as number) > 0) riscos.push('Próximo ajuste de dificuldade estimado para cima reduz a receita por hashrate.');
  if (v('risk.level') && v('risk.level') !== 'normal') riscos.push(`Guardião em estado ${String(v('risk.level'))}.`);
  const resumo = `${simulated ? 'Análise sobre dados SIMULADOS. ' : ''}Nível de evidência de mineração: ${String(v('system.evidence_level') ?? 0)}. ` +
    `${riscos.length ? `${riscos.length} ponto(s) de atenção identificado(s).` : 'Nenhum ponto de atenção pelas regras atuais.'} ` +
    'Valores de receita são estimativas e não garantem retorno.';
  return { resumo, riscos };
}

export const estrategia: AgentDefinition[] = [
  {
    id: 31,
    code: 'A31-ESTRATEGISTA',
    name: 'Estrategista',
    department: 7,
    responsibility: 'Gera recomendações por regras explícitas (resultado negativo, rejeição alta, temperatura, ausência de shares). Propõe, nunca executa.',
    mode: 'scheduled',
    intervalMs: 15 * MIN,
    permissions: ['read:metrics', 'write:metrics', 'propose:action'],
    inputs: ['estimativas de rentabilidade', 'shares', 'temperatura', 'evidência'],
    outputs: ['strategy.recommendations', 'eventos strategy.recommendation'],
    maturity: 'validado',
    async run(ctx) {
      const recs: string[] = [];
      const net = ctx.metrics.get('profit.net_day');
      if (net && typeof net.value === 'number' && net.value < 0) {
        ctx.memory.negativeRuns = Number(ctx.memory.negativeRuns ?? 0) + 1;
        recs.push(`Resultado estimado negativo (${net.value.toFixed(2)} ${ctx.config.localCurrency}/dia): avaliar pausa do minerador.`);
        if (Number(ctx.memory.negativeRuns) >= 2 && ctx.now() - Number(ctx.memory.lastPauseProposal ?? 0) > 6 * HOUR) {
          ctx.memory.lastPauseProposal = ctx.now();
          ctx.proposeAction({ kind: 'pause_miner', params: {}, reason: 'resultado diário estimado negativo em duas avaliações seguidas', evidence: net.provenance });
        }
      } else ctx.memory.negativeRuns = 0;
      const rej = ctx.metrics.num('miner.reject_rate_pct');
      if (rej !== undefined && rej > 2) recs.push('Rejeição de shares acima de 2%: verificar latência e configuração da pool.');
      const temp = ctx.metrics.num('miner.temperature_c');
      if (temp !== undefined && temp >= ctx.config.maxTempC - 5) recs.push('Temperatura próxima do limite: revisar ventilação.');
      const lvl = ctx.metrics.num('system.evidence_level') ?? 0;
      if (lvl === 2) recs.push('Hashrate informado sem shares aceitas: conferir usuário/carteira e endereço da pool.');
      if (lvl === 0) recs.push('Sem conexão com minerador: configure MINER_TYPE e MINER_URL.');
      return {
        status: 'ok',
        summary: recs.length ? recs.join(' ') : 'Nenhuma recomendação no momento',
        metrics: [metric('strategy.recommendations', recs.length, 'real', 'regras')],
        events: recs.map((r) => ({ type: 'strategy.recommendation', severity: 'info' as const, message: r })),
      };
    },
  },
  {
    id: 32,
    code: 'A32-CENARIOS',
    name: 'Simulador de Cenários',
    department: 7,
    responsibility: 'Calcula sensibilidade do resultado a variações de preço (±20%), dificuldade (+10%) e tarifa (+20%).',
    mode: 'scheduled',
    intervalMs: HOUR,
    triggers: ['scenario.requested'],
    permissions: ['read:metrics', 'write:metrics'],
    inputs: ['hashrate', 'dificuldade', 'preço', 'potência', 'tarifa'],
    outputs: ['scenario.worst_net_day', 'scenario.best_net_day', 'relatório scenarios'],
    maturity: 'validado',
    async run(ctx) {
      const m = ctx.metrics;
      const cur = ctx.config.localCurrency;
      const hr = m.get('miner.hashrate_15m_hs') ?? m.get('miner.hashrate_hs');
      const diff = m.get('network.difficulty');
      const sub = m.get('network.block_subsidy_btc');
      const price = m.get(`price.BTC-${cur}`);
      const power = m.num('energy.power_w');
      const tariff = m.num('energy.tariff_kwh');
      if (!hr || !diff || !sub || !price || power === undefined || tariff === undefined) return { status: 'skipped', summary: 'dados insuficientes para cenários' };
      const prov = asEstimate(hr.provenance, diff.provenance, price.provenance);
      const rows: { preco: number; dificuldade: number; tarifa: number; resultado_dia: number }[] = [];
      for (const p of [0.8, 1, 1.2]) for (const d of [1, 1.1]) for (const t of [1, 1.2]) {
        const btc = expectedBtcPerDay(Number(hr.value), Number(diff.value) * d, Number(sub.value));
        const net = btc * Number(price.value) * p - ((power * 24) / 1000) * tariff * t;
        rows.push({ preco: p, dificuldade: d, tarifa: t, resultado_dia: Math.round(net * 100) / 100 });
      }
      const nets = rows.map((r) => r.resultado_dia);
      ctx.services.store.insertReport('scenarios', { provenance: prov, moeda: cur, rows }, ctx.now());
      return {
        status: 'ok',
        summary: `${rows.length} cenários · pior ${Math.min(...nets).toFixed(2)} · melhor ${Math.max(...nets).toFixed(2)} ${cur}/dia (estimativas)`,
        metrics: [metric('scenario.worst_net_day', Math.min(...nets), prov, 'cenários', cur), metric('scenario.best_net_day', Math.max(...nets), prov, 'cenários', cur)],
      };
    },
  },
  {
    id: 33,
    code: 'A33-GATEWAY-LLM',
    name: 'Gateway de LLM',
    department: 7,
    responsibility: 'Único ponto de acesso a modelo de linguagem: controla limites diários e mensais e publica disponibilidade e consumo.',
    mode: 'scheduled',
    intervalMs: 10 * MIN,
    permissions: ['call:llm', 'write:metrics', 'emit:alert'],
    inputs: ['LLM_ENABLED', 'ANTHROPIC_API_KEY', 'limites de uso'],
    outputs: ['llm.enabled', 'llm.calls_today', 'llm.tokens_month'],
    maturity: 'validado',
    async run(ctx) {
      const s = ctx.services.llm.status();
      if (ctx.config.llmEnabled && s.tokensThisMonth > s.maxTokensPerMonth * 0.8) ctx.raiseAlert('llm.budget', 'warn', `Consumo de tokens em ${Math.round((s.tokensThisMonth / s.maxTokensPerMonth) * 100)}% do limite mensal`);
      return {
        status: s.enabled ? 'ok' : 'skipped',
        summary: s.enabled ? `Disponível · ${s.callsToday}/${s.maxCallsPerDay} chamadas hoje · ${s.tokensThisMonth} tokens no mês` : `Indisponível: ${s.reason}`,
        metrics: [metric('llm.enabled', s.enabled, 'real', 'gateway'), metric('llm.calls_today', s.callsToday, 'real', 'gateway'), metric('llm.tokens_month', s.tokensThisMonth, 'real', 'gateway')],
      };
    },
  },
  {
    id: 34,
    code: 'A34-REDATOR',
    name: 'Redator de Análises',
    department: 7,
    responsibility: 'Produz uma análise curta em português. Usa o LLM quando habilitado e valida a saída; caso contrário, usa texto determinístico.',
    mode: 'scheduled',
    intervalMs: 6 * HOUR,
    triggers: ['analysis.requested'],
    permissions: ['read:metrics', 'call:llm', 'write:metrics'],
    inputs: ['métricas consolidadas'],
    outputs: ['relatório analysis'],
    timeoutMs: 45_000,
    maturity: 'validado',
    async run(ctx) {
      const data = snapshotForAnalysis(ctx);
      let analysis = deterministicAnalysis(data);
      let source = 'determinístico';
      let note = '';
      const st = ctx.services.llm.status();
      if (st.enabled) {
        const nums = Object.values(data).map((d) => d.valor).filter((v): v is number => typeof v === 'number');
        const r = await ctx.services.llm.complete({
          agentId: ctx.agentId,
          purpose: 'analise',
          system: 'Você é analista de operações de mineração. Responda apenas com JSON {"resumo": string, "riscos": string[]} em português. Use somente os números fornecidos. Nunca prometa lucro ou retorno. Diga explicitamente quando os dados forem simulados ou estimados.',
          prompt: `Dados atuais (valor e procedência):\n${JSON.stringify(data)}`,
          maxTokens: 500,
        });
        if (r.ok) {
          const v = validateAnalysis(r.text, nums);
          if (v.ok) { analysis = v.value; source = 'llm'; }
          else note = `saída do LLM rejeitada (${v.reason}); usado texto determinístico`;
        } else note = `LLM indisponível (${r.reason}); usado texto determinístico`;
      }
      ctx.services.store.insertReport('analysis', { ...analysis, fonte: source, dados: data, observacao: note || undefined }, ctx.now());
      return { status: 'ok', summary: `Análise gerada (${source})${note ? ' · ' + note : ''}` };
    },
  },
  {
    id: 35,
    code: 'A35-AVALIADOR',
    name: 'Avaliador de Recomendações',
    department: 7,
    responsibility: 'Mede o histórico de propostas: aprovadas, rejeitadas, bloqueadas e executadas com sucesso.',
    mode: 'scheduled',
    intervalMs: 6 * HOUR,
    permissions: ['write:metrics'],
    inputs: ['histórico de ações'],
    outputs: ['strategy.acceptance_rate', 'strategy.blocked'],
    maturity: 'validado',
    async run(ctx) {
      const acts = ctx.services.store.listActions({ limit: 500 });
      const by = (s: string) => acts.filter((a) => a.status === s).length;
      const decided = by('aprovada_operador') + by('executada') + by('falhou') + by('rejeitada');
      const accepted = decided - by('rejeitada');
      const rate = decided ? Math.round((accepted / decided) * 100) : 0;
      return {
        status: 'ok',
        summary: `${acts.length} propostas · aceitas ${accepted}/${decided} · bloqueadas ${by('bloqueada')} · executadas ${by('executada')}`,
        metrics: [metric('strategy.acceptance_rate', rate, 'real', 'histórico', '%'), metric('strategy.blocked', by('bloqueada'), 'real', 'histórico')],
      };
    },
  },
];
