// Departamento 10 — Comunicação e controle (agentes 46–50)
import type { AgentDefinition } from '../core/types.ts';
import { computeEvidence } from '../core/evidence.ts';
import { HOUR, MIN, SEC, metric } from './common.ts';

export const comunicacao: AgentDefinition[] = [
  {
    id: 46,
    code: 'A46-CONSOLE',
    name: 'Console de Eventos',
    department: 10,
    responsibility: 'Mede o fluxo do console de eventos: eventos por minuto e erros na última hora.',
    mode: 'continuous',
    intervalMs: 30 * SEC,
    permissions: ['write:metrics'],
    inputs: ['eventos persistidos'],
    outputs: ['events.per_min', 'events.errors_1h'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const store = ctx.services.store;
      const perMin = store.countEventsSince(ctx.now() - MIN);
      const errors = store.listEvents({ severity: ['error', 'critical'], since: ctx.now() - HOUR, limit: 1000 }).length;
      return { status: 'ok', summary: `${perMin} evento(s)/min · ${errors} erro(s) na última hora`, metrics: [metric('events.per_min', perMin, 'real', 'console'), metric('events.errors_1h', errors, 'real', 'console')] };
    },
  },
  {
    id: 47,
    code: 'A47-ALERTAS',
    name: 'Central de Alertas',
    department: 10,
    responsibility: 'Consolida alertas abertos por severidade e escala alertas recorrentes.',
    mode: 'event',
    triggers: ['alert.raised', 'alert.repeated'],
    permissions: ['write:metrics', 'emit:alert'],
    inputs: ['alert.raised', 'alert.repeated'],
    outputs: ['alerts.open', 'alerts.critical'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const open = ctx.services.store.listAlerts({ openOnly: true, limit: 500 });
      const critical = open.filter((a) => a.severity === 'critical').length;
      for (const a of open) {
        if (a.count >= 5 && a.severity === 'warn' && !a.code.endsWith('.escalado')) {
          ctx.raiseAlert(`${a.code}.escalado`, 'error', `Alerta recorrente (${a.count}x): ${a.message}`);
        }
      }
      return { status: 'ok', summary: `${open.length} alerta(s) aberto(s) · ${critical} crítico(s)`, metrics: [metric('alerts.open', open.length, 'real', 'alertas'), metric('alerts.critical', critical, 'real', 'alertas')] };
    },
  },
  {
    id: 48,
    code: 'A48-NOTIFICADOR',
    name: 'Notificador',
    department: 10,
    responsibility: 'Envia alertas de severidade erro ou crítica para o Telegram do operador, quando configurado.',
    mode: 'event',
    triggers: ['alert.raised'],
    permissions: ['notify:external'],
    inputs: ['alert.raised', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
    outputs: ['mensagem no Telegram'],
    maturity: 'stub',
    async run(ctx) {
      const e = ctx.trigger;
      if (!e || (e.severity !== 'error' && e.severity !== 'critical')) return { status: 'skipped', summary: 'alerta abaixo do nível de notificação' };
      const { telegramBotToken: token, telegramChatId: chat } = ctx.config;
      if (!token || !chat) return { status: 'skipped', summary: 'Telegram não configurado' };
      await ctx.services.http.postJson(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: `[Office 50] ${e.severity.toUpperCase()}: ${e.message}` });
      return { status: 'ok', summary: 'Notificação enviada ao Telegram' };
    },
  },
  {
    id: 49,
    code: 'A49-RELATORIOS',
    name: 'Gerador de Relatórios e Métricas',
    department: 10,
    responsibility: 'Gera o relatório operacional consolidado: agentes, evidência de mineração, métricas-chave com procedência e alertas.',
    mode: 'scheduled',
    intervalMs: HOUR,
    triggers: ['report.requested'],
    permissions: ['read:runtime', 'read:metrics', 'write:metrics'],
    inputs: ['estado dos agentes', 'métricas', 'alertas'],
    outputs: ['relatório operational'],
    maturity: 'validado',
    async run(ctx) {
      const agents = ctx.services.runtime.agents();
      const states: Record<string, number> = {};
      for (const a of agents) states[a.state] = (states[a.state] ?? 0) + 1;
      const ev = computeEvidence((k) => ctx.metrics.get(k), ctx.now());
      const keys = ['miner.hashrate_hs', 'miner.shares_accepted', 'miner.reject_rate_pct', 'miner.temperature_c', 'pool.balance', 'wallet.balance_btc', 'finance.confirmed_received_btc', 'profit.revenue_day', 'profit.energy_cost_day', 'profit.net_day', 'price.BTC-USD', 'network.difficulty'];
      const metrics = keys.map((k) => ctx.metrics.get(k)).filter(Boolean).map((m) => ({ chave: m!.key, valor: m!.value, unidade: m!.unit, procedencia: m!.provenance, fonte: m!.source, em: new Date(m!.ts).toISOString() }));
      const alerts = ctx.services.store.listAlerts({ openOnly: true, limit: 20 }).map((a) => ({ severidade: a.severity, mensagem: a.message, vezes: a.count }));
      const report = { geradoEm: new Date(ctx.now()).toISOString(), agentes: { total: agents.length, estados: states }, evidencia: ev, metricas: metrics, alertasAbertos: alerts };
      ctx.services.store.insertReport('operational', report, ctx.now());
      return { status: 'ok', summary: `Relatório operacional gerado · ${metrics.length} métricas · ${alerts.length} alertas abertos`, metrics: [metric('reports.last_at', ctx.now(), 'real', 'relatórios')] };
    },
  },
  {
    id: 50,
    code: 'A50-OPERADOR',
    name: 'Interface do Operador',
    department: 10,
    responsibility: 'Mantém a API e o canal em tempo real do escritório 3D; publica clientes conectados e tempo ativo.',
    mode: 'continuous',
    intervalMs: 30 * SEC,
    permissions: ['read:runtime', 'write:metrics'],
    inputs: ['conexões da interface'],
    outputs: ['ui.clients', 'app.uptime_s'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const rt = ctx.services.runtime;
      const up = Math.floor((ctx.now() - rt.startedAt) / 1000);
      return { status: 'ok', summary: `${rt.clientCount()} cliente(s) conectado(s) · ativo há ${Math.floor(up / 60)} min`, metrics: [metric('ui.clients', rt.clientCount(), 'real', 'api'), metric('app.uptime_s', up, 'real', 'runtime', 's')] };
    },
  },
];
