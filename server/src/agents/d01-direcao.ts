// Departamento 1 — Direção e coordenação (agentes 1–5)
import type { AgentDefinition } from '../core/types.ts';
import { computeEvidence } from '../core/evidence.ts';
import { DEPARTMENTS, MIN, SEC, metric } from './common.ts';

export const direcao: AgentDefinition[] = [
  {
    id: 1,
    code: 'A01-DIRETOR',
    name: 'Diretor Geral',
    department: 1,
    responsibility: 'Consolida o estado coletivo dos 50 agentes, o nível de evidência de mineração e o índice de saúde do sistema.',
    mode: 'scheduled',
    intervalMs: 60 * SEC,
    permissions: ['read:runtime', 'read:metrics', 'write:metrics', 'emit:alert'],
    inputs: ['estado dos agentes', 'métricas de mineração'],
    outputs: ['system.health_score', 'system.evidence_level', 'director.summary'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const agents = ctx.services.runtime.agents();
      const bad = agents.filter((a) => a.state === 'erro' || a.state === 'desconectado').length;
      const score = Math.round(((agents.length - bad) / Math.max(1, agents.length)) * 100);
      const ev = computeEvidence((k) => ctx.metrics.get(k), ctx.now());
      if (score < 70) ctx.raiseAlert('system.health_low', 'warn', `Saúde do sistema em ${score}%: ${bad} agentes com erro ou desconectados`);
      return {
        status: 'ok',
        summary: `Saúde ${score}% · evidência nível ${ev.level} (${ev.label})${ev.simulated ? ' · SIMULAÇÃO' : ''}`,
        metrics: [
          metric('system.health_score', score, 'real', 'runtime', '%'),
          metric('system.evidence_level', ev.level, ev.simulated ? 'simulado' : 'real', 'evidence'),
          metric('system.mining_active', ev.miningActive, ev.simulated ? 'simulado' : 'real', 'evidence'),
        ],
      };
    },
  },
  {
    id: 2,
    code: 'A02-COORDENADOR',
    name: 'Coordenador de Tarefas',
    department: 1,
    responsibility: 'Supervisiona a fila: tamanho, concorrência, duplicatas evitadas e tarefas presas, que encerra com falha.',
    mode: 'continuous',
    intervalMs: 10 * SEC,
    permissions: ['read:runtime', 'write:metrics', 'emit:alert'],
    inputs: ['fila de tarefas'],
    outputs: ['queue.queued', 'queue.running', 'queue.duplicates_skipped'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const rt = ctx.services.runtime;
      const q = rt.queueStats();
      const stuck = rt.stuckTasks(ctx.config.taskTimeoutMs * (ctx.config.maxRetries + 2) * 2);
      for (const t of stuck) rt.failTask(t.id, 'tarefa presa encerrada pelo coordenador');
      if (stuck.length) ctx.raiseAlert('queue.stuck', 'warn', `${stuck.length} tarefa(s) presa(s) encerrada(s)`);
      if (q.queued > 40) ctx.raiseAlert('queue.backlog', 'warn', `Fila com ${q.queued} tarefas aguardando`);
      return {
        status: 'ok',
        summary: `Fila ${q.queued} · executando ${q.running}/${q.maxConcurrency} · duplicatas evitadas ${q.duplicatesSkipped}`,
        metrics: [
          metric('queue.queued', q.queued, 'real', 'runtime'),
          metric('queue.running', q.running, 'real', 'runtime'),
          metric('queue.duplicates_skipped', q.duplicatesSkipped, 'real', 'runtime'),
        ],
      };
    },
  },
  {
    id: 3,
    code: 'A03-REGISTRO',
    name: 'Registro Central',
    department: 1,
    responsibility: 'Valida a integridade do registro: 50 agentes, 5 por departamento, códigos únicos e contratos completos.',
    mode: 'scheduled',
    intervalMs: 5 * MIN,
    permissions: ['read:runtime', 'write:metrics', 'emit:alert'],
    inputs: ['definições dos agentes'],
    outputs: ['registry.count', 'registry.valid'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const defs = ctx.services.runtime.definitions();
      const problems: string[] = [];
      if (defs.length !== 50) problems.push(`esperados 50 agentes, encontrados ${defs.length}`);
      for (const d of DEPARTMENTS) {
        const n = defs.filter((a) => a.department === d.id).length;
        if (n !== 5) problems.push(`departamento ${d.id} com ${n} agentes`);
      }
      for (const a of defs) {
        if (a.department !== Math.ceil(a.id / 5)) problems.push(`${a.code} no departamento errado`);
        if (!a.responsibility || !a.inputs.length || !a.outputs.length || !a.permissions.length) problems.push(`${a.code} com contrato incompleto`);
      }
      if (problems.length) ctx.raiseAlert('registry.invalid', 'error', `Registro inconsistente: ${problems.join('; ')}`);
      return {
        status: 'ok',
        summary: problems.length ? `Inconsistências: ${problems.length}` : `${defs.length} agentes íntegros em ${DEPARTMENTS.length} departamentos`,
        metrics: [metric('registry.count', defs.length, 'real', 'runtime'), metric('registry.valid', problems.length === 0, 'real', 'runtime')],
      };
    },
  },
  {
    id: 4,
    code: 'A04-SAUDE',
    name: 'Supervisor de Saúde',
    department: 1,
    responsibility: 'Verifica batimentos: agentes contínuos e agendados sem sucesso recente e agentes com falhas consecutivas.',
    mode: 'continuous',
    intervalMs: 30 * SEC,
    permissions: ['read:runtime', 'write:metrics', 'emit:alert'],
    inputs: ['estado dos agentes'],
    outputs: ['health.stale_agents', 'health.failing_agents'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const rt = ctx.services.runtime;
      const now = ctx.now();
      const warmup = now - rt.startedAt < 3 * MIN;
      const stale = warmup
        ? []
        : rt.agents().filter((a) =>
            a.mode !== 'event' && a.intervalMs !== undefined && a.lastRunAt !== undefined &&
            a.state !== 'bloqueado' && a.state !== 'desconectado' && a.state !== 'ocioso' &&
            (!a.lastSuccessAt || now - a.lastSuccessAt > a.intervalMs * 3));
      if (stale.length) ctx.raiseAlert('health.stale', 'warn', `Sem sucesso recente: ${stale.map((a) => a.code).join(', ')}`);
      const failing = rt.agents().filter((a) => a.consecutiveFailures >= 3);
      for (const a of failing) ctx.raiseAlert(`health.failing.${a.id}`, 'error', `${a.code} falhou ${a.consecutiveFailures} vezes seguidas: ${a.lastError}`);
      return {
        status: 'ok',
        summary: `${stale.length} sem sucesso recente · ${failing.length} com falhas consecutivas`,
        metrics: [metric('health.stale_agents', stale.length, 'real', 'runtime'), metric('health.failing_agents', failing.length, 'real', 'runtime')],
      };
    },
  },
  {
    id: 5,
    code: 'A05-CONFIG',
    name: 'Gestor de Configuração e Políticas',
    department: 1,
    responsibility: 'Valida a configuração na inicialização e periodicamente: fontes de dados, limites, segredos ausentes e combinações inseguras.',
    mode: 'scheduled',
    intervalMs: 30 * MIN,
    permissions: ['write:metrics', 'emit:alert'],
    inputs: ['variáveis de ambiente'],
    outputs: ['config.warnings', 'config.data_mode'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const c = ctx.config;
      const w: string[] = [];
      if ((c.minerType === 'xmrig' || c.minerType === 'cgminer') && !c.minerUrl) w.push('MINER_URL ausente para o minerador real');
      if (c.poolSource === 'json' && !c.poolStatsUrl) w.push('POOL_STATS_URL ausente');
      if (c.poolSource === 'luxor' && !c.luxorApiKey) w.push('POOL_SOURCE=luxor sem LUXOR_API_KEY');
      if (c.poolSource === 'luxor' && !c.luxorSubaccount) w.push('LUXOR_SUBACCOUNT não definido: necessário para configurar o minerador');
      if (c.walletSource === 'mempool' && !c.walletBtcAddress) w.push('WALLET_BTC_ADDRESS ausente');
      if (c.llmEnabled && !c.anthropicApiKey) w.push('LLM_ENABLED sem ANTHROPIC_API_KEY');
      if (c.maxTempC >= c.criticalTempC) w.push('MAX_TEMP_C deve ser menor que CRITICAL_TEMP_C');
      if (c.host !== '127.0.0.1' && c.host !== 'localhost' && !c.apiToken) w.push('servidor exposto na rede sem API_TOKEN');
      if (c.powerWatts === undefined && c.minerType !== 'simulated') w.push('POWER_WATTS não informado: custo de energia ficará indisponível');
      if (c.energyPriceKwh === undefined && c.minerType !== 'simulated') w.push('ENERGY_PRICE_KWH não informado: rentabilidade líquida indisponível');
      const sources = [c.marketSource, c.networkSource, c.minerType, c.poolSource, c.walletSource];
      const mode = sources.every((s) => s === 'simulated') ? 'simulação' : sources.some((s) => s === 'simulated') ? 'misto' : 'real';
      if (w.length) ctx.raiseAlert('config.warnings', 'warn', `Configuração: ${w.join('; ')}`);
      return {
        status: 'ok',
        summary: `Modo de dados: ${mode} · ${w.length} aviso(s)`,
        metrics: [metric('config.warnings', w.length, 'real', 'config'), metric('config.data_mode', mode, 'real', 'config')],
      };
    },
  },
];
