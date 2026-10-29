// Departamento 6 — Risco e segurança (agentes 26–30)
// O Guardião (26) opera exclusivamente com regras determinísticas (core/riskGuardian.ts).
import type { AgentDefinition } from '../core/types.ts';
import { HOUR, MIN, SEC, metric } from './common.ts';

const SECRET_VARS = ['API_TOKEN', 'MINER_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN'] as const;

export const risco: AgentDefinition[] = [
  {
    id: 26,
    code: 'A26-GUARDIAO',
    name: 'Guardião de Risco',
    department: 6,
    responsibility: 'Avalia regras determinísticas de risco, pausa o sistema em condição crítica e bloqueia ações proibidas. Não usa LLM.',
    mode: 'continuous',
    intervalMs: 10 * SEC,
    triggers: ['metric.miner.temperature_c', 'metric.miner.reject_rate_pct'],
    permissions: ['read:metrics', 'read:miner', 'write:metrics', 'emit:alert', 'control:system'],
    inputs: ['métricas de temperatura, shares e carteira', 'regras R01–R08, S01–S04'],
    outputs: ['risk.level', 'risk.findings', 'system.paused'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const g = ctx.services.guardian;
      const wasPaused = g.pauseState().paused;
      g.minerProvenance = ctx.services.miner.adapter.provenance;
      const r = g.checkState();
      if (!wasPaused && r.paused) {
        ctx.emit({ type: 'system.paused', severity: 'critical', message: `Guardião pausou o sistema: ${r.findings.join('; ')}`, data: { by: 'guardiao' } });
      }
      if (r.level === 'critico') ctx.raiseAlert('risk.critical', 'critical', r.findings.join('; '));
      return {
        status: 'ok',
        summary: `Risco ${r.level}${r.findings.length ? ': ' + r.findings.join('; ') : ''}${r.paused ? ' · SISTEMA PAUSADO' : ''}`,
        metrics: [
          metric('risk.level', r.level, 'real', 'guardiao'),
          metric('risk.findings', r.findings.length, 'real', 'guardiao'),
          metric('system.paused', r.paused, 'real', 'guardiao'),
        ],
      };
    },
  },
  {
    id: 27,
    code: 'A27-COFRE',
    name: 'Cofre de Credenciais',
    department: 6,
    responsibility: 'Verifica quais segredos estão configurados sem jamais exibir seus valores e detecta segredos fracos.',
    mode: 'scheduled',
    intervalMs: HOUR,
    permissions: ['read:secrets', 'write:metrics', 'emit:alert'],
    inputs: ['variáveis de ambiente sensíveis'],
    outputs: ['secrets.configured', 'secrets.weak'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const c = ctx.config;
      const values: Record<(typeof SECRET_VARS)[number], string | undefined> = {
        API_TOKEN: c.apiToken, MINER_ACCESS_TOKEN: c.minerAccessToken, ANTHROPIC_API_KEY: c.anthropicApiKey, TELEGRAM_BOT_TOKEN: c.telegramBotToken,
      };
      const configured = SECRET_VARS.filter((k) => values[k]);
      const weak = (['API_TOKEN', 'MINER_ACCESS_TOKEN'] as const).filter((k) => values[k] && values[k]!.length < 16);
      if (weak.length) ctx.raiseAlert('secrets.weak', 'warn', `Segredos curtos demais (mín. 16 caracteres): ${weak.join(', ')}`);
      return {
        status: 'ok',
        summary: `Configurados: ${configured.length ? configured.join(', ') : 'nenhum'}${weak.length ? ` · fracos: ${weak.join(', ')}` : ''}`,
        metrics: [metric('secrets.configured', configured.length, 'real', 'config'), metric('secrets.weak', weak.length, 'real', 'config')],
      };
    },
  },
  {
    id: 28,
    code: 'A28-SEGURANCA',
    name: 'Monitor de Segurança',
    department: 6,
    responsibility: 'Verifica exposição da API, proteção da API do minerador e a lista de carteiras permitidas.',
    mode: 'scheduled',
    intervalMs: 10 * MIN,
    permissions: ['read:metrics', 'write:metrics', 'emit:alert'],
    inputs: ['HOST', 'API_TOKEN', 'MINER_ACCESS_TOKEN', 'ALLOWED_WALLETS'],
    outputs: ['security.issues'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const c = ctx.config;
      const issues: string[] = [];
      const exposed = !['127.0.0.1', 'localhost', '::1'].includes(c.host);
      if (exposed && !c.apiToken) issues.push('painel acessível na rede sem API_TOKEN');
      if (c.minerType === 'xmrig' && !c.minerAccessToken) issues.push('API do XMRig sem access-token');
      if (c.walletSource === 'mempool' && c.walletBtcAddress && c.allowedWallets.length && !c.allowedWallets.includes(c.walletBtcAddress)) {
        issues.push('carteira monitorada não consta em ALLOWED_WALLETS');
      }
      if (c.walletSource === 'mempool' && !c.allowedWallets.length) issues.push('ALLOWED_WALLETS vazio: defina a lista de carteiras de recebimento permitidas');
      if (issues.length) ctx.raiseAlert('security.issues', exposed && !c.apiToken ? 'error' : 'warn', issues.join('; '));
      return { status: 'ok', summary: issues.length ? issues.join('; ') : 'Nenhum problema de segurança detectado', metrics: [metric('security.issues', issues.length, 'real', 'verificação')] };
    },
  },
  {
    id: 29,
    code: 'A29-LIMITADOR',
    name: 'Limitador de Chamadas Externas',
    department: 6,
    responsibility: 'Publica o uso do limitador de chamadas por host e alerta quando chamadas são contidas.',
    mode: 'continuous',
    intervalMs: MIN,
    permissions: ['write:metrics', 'emit:alert'],
    inputs: ['estatísticas do limitador'],
    outputs: ['ratelimit.allowed', 'ratelimit.throttled'],
    maturity: 'validado',
    async run(ctx) {
      const stats = ctx.services.limiter.stats();
      const allowed = stats.reduce((a, s) => a + s.allowed, 0);
      const throttled = stats.reduce((a, s) => a + s.throttled, 0);
      const prev = Number(ctx.memory.prevThrottled ?? 0);
      if (throttled - prev > 5) ctx.raiseAlert('ratelimit.throttled', 'warn', `${throttled - prev} chamadas externas contidas pelo limitador`);
      ctx.memory.prevThrottled = throttled;
      return {
        status: 'ok',
        summary: `${stats.length} host(s) · permitidas ${allowed} · contidas ${throttled}`,
        metrics: [metric('ratelimit.allowed', allowed, 'real', 'limitador'), metric('ratelimit.throttled', throttled, 'real', 'limitador')],
      };
    },
  },
  {
    id: 30,
    code: 'A30-PROCEDENCIA',
    name: 'Validador de Procedência de Dados',
    department: 6,
    responsibility: 'Garante que toda métrica tem procedência válida, detecta dados vencidos e mistura de dados reais com simulados.',
    mode: 'scheduled',
    intervalMs: 2 * MIN,
    permissions: ['read:metrics', 'write:metrics', 'emit:alert'],
    inputs: ['todas as métricas atuais'],
    outputs: ['data.real', 'data.estimado', 'data.simulado', 'data.stale'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const all = ctx.metrics.all();
      const counts = { real: 0, estimado: 0, simulado: 0, teste: 0 } as Record<string, number>;
      const invalid: string[] = [];
      let stale = 0;
      for (const m of all) {
        if (!(m.provenance in counts)) invalid.push(m.key);
        else counts[m.provenance]++;
        if (ctx.now() - m.ts > 6 * HOUR) stale++;
      }
      // Um dado "real" derivado de fonte simulada indica erro de etiquetagem.
      const mislabeled = all.filter((m) => m.provenance === 'real' && /simulador/i.test(m.source)).map((m) => m.key);
      if (invalid.length || mislabeled.length) ctx.raiseAlert('data.provenance', 'error', `Procedência inválida em: ${[...invalid, ...mislabeled].join(', ')}`);
      return {
        status: 'ok',
        summary: `real ${counts.real} · estimado ${counts.estimado} · simulado ${counts.simulado} · teste ${counts.teste} · vencidos ${stale}`,
        metrics: [
          metric('data.real', counts.real, 'real', 'validador'),
          metric('data.estimado', counts.estimado, 'real', 'validador'),
          metric('data.simulado', counts.simulado, 'real', 'validador'),
          metric('data.stale', stale, 'real', 'validador'),
        ],
      };
    },
  },
];
