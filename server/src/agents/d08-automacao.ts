// Departamento 8 — Automação e manutenção (agentes 36–40)
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDefinition } from '../core/types.ts';
import { HOUR, MIN, compareVersions, metric } from './common.ts';

export const APP_VERSION = '0.1.0';

export const MAINTENANCE_TASKS = [
  { id: 'limpeza', label: 'Limpeza de filtros, ventoinhas e dissipadores', everyDays: 30 },
  { id: 'firmware', label: 'Verificar atualização de firmware/minerador', everyDays: 90 },
  { id: 'restauracao', label: 'Testar a restauração de um backup', everyDays: 30 },
  { id: 'credenciais', label: 'Revisar tokens e credenciais', everyDays: 180 },
];

export const automacao: AgentDefinition[] = [
  {
    id: 36,
    code: 'A36-MANUTENCAO',
    name: 'Agendador de Manutenção',
    department: 8,
    responsibility: 'Controla a agenda de manutenção preventiva e alerta tarefas vencidas.',
    mode: 'scheduled',
    intervalMs: HOUR,
    permissions: ['write:metrics', 'emit:alert'],
    inputs: ['registro de manutenções concluídas'],
    outputs: ['maintenance.overdue'],
    maturity: 'validado',
    async run(ctx) {
      const done = ctx.services.store.getKV<Record<string, number>>('maintenance.done', {});
      const startedAt = ctx.services.store.getKV<number>('maintenance.since', 0) || ctx.now();
      ctx.services.store.setKV('maintenance.since', startedAt, ctx.now());
      const overdue = MAINTENANCE_TASKS.filter((t) => ctx.now() - (done[t.id] ?? startedAt) > t.everyDays * 24 * HOUR);
      if (overdue.length) ctx.raiseAlert('maintenance.overdue', 'info', `Manutenção vencida: ${overdue.map((t) => t.label).join('; ')}`);
      return { status: 'ok', summary: overdue.length ? `${overdue.length} manutenção(ões) vencida(s)` : 'Agenda de manutenção em dia', metrics: [metric('maintenance.overdue', overdue.length, 'real', 'agenda')] };
    },
  },
  {
    id: 37,
    code: 'A37-EXECUTOR',
    name: 'Executor de Ações',
    department: 8,
    responsibility: 'Executa somente ações aprovadas pelo operador e reavaliadas pelo Guardião no momento da execução. Nunca executa operações financeiras.',
    mode: 'event',
    triggers: ['action.approved'],
    permissions: ['execute:action', 'read:miner'],
    inputs: ['action.approved'],
    outputs: ['action.executed', 'action.failed'],
    maturity: 'validado',
    async run(ctx) {
      const id = String(ctx.trigger?.data?.actionId ?? '');
      const store = ctx.services.store;
      const a = store.getAction(id);
      if (!a) return { status: 'skipped', summary: 'ação não encontrada' };
      if (a.status !== 'aprovada_operador') return { status: 'skipped', summary: `ação em estado ${a.status}` };
      const ev = ctx.services.guardian.evaluate(a);
      if (!ev.allowed) {
        a.status = 'bloqueada';
        a.guardianReasons = ev.reasons;
        store.saveAction(a);
        return { status: 'ok', summary: `Guardião bloqueou na execução: ${ev.reasons.join('; ')}`, events: [{ type: 'action.blocked', severity: 'warn', message: `Execução bloqueada: ${a.kind}`, data: { actionId: a.id } }] };
      }
      const adapter = ctx.services.miner.adapter;
      let result: string;
      let ok = false;
      if ((a.kind === 'pause_miner' || a.kind === 'resume_miner') && adapter.control) {
        try {
          result = await adapter.control(a.kind === 'pause_miner' ? 'pause' : 'resume');
          ok = true;
          ctx.services.miner.invalidate();
        } catch (e) {
          result = `falha: ${(e as Error).message}`;
        }
      } else {
        result = `ação "${a.kind}" não é suportada pelo adaptador ${adapter.type}; execute manualmente no equipamento`;
      }
      a.status = ok ? 'executada' : 'falhou';
      a.result = result;
      store.saveAction(a);
      return {
        status: 'ok',
        summary: result,
        events: [{ type: ok ? 'action.executed' : 'action.failed', severity: ok ? 'info' : 'warn', message: `${a.kind}: ${result}`, data: { actionId: a.id } }],
      };
    },
  },
  {
    id: 38,
    code: 'A38-RECUPERACAO',
    name: 'Reiniciador de Processos',
    department: 8,
    responsibility: 'Aplica espera progressiva (circuit breaker) a agentes internos com falhas consecutivas. Não reinicia equipamentos.',
    mode: 'event',
    triggers: ['agent.error'],
    permissions: ['read:runtime', 'read:miner', 'emit:alert'],
    inputs: ['agent.error'],
    outputs: ['período de espera do agente'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const agentId = Number(ctx.trigger?.agentId);
      const info = ctx.services.runtime.agent(agentId);
      if (!info) return { status: 'skipped', summary: 'agente desconhecido' };
      if (info.consecutiveFailures < 3) return { status: 'skipped', summary: `${info.code}: ${info.consecutiveFailures} falha(s), abaixo do limite` };
      const minutes = Math.min(30, 2 ** (info.consecutiveFailures - 3));
      ctx.services.runtime.setCooldown(agentId, ctx.now() + minutes * MIN);
      if ([11, 12, 13, 14, 16, 22].includes(agentId)) ctx.services.miner.invalidate();
      return { status: 'ok', summary: `${info.code} em espera por ${minutes} min após ${info.consecutiveFailures} falhas`, events: [{ type: 'agent.cooldown', severity: 'warn', message: `${info.code} em espera por ${minutes} min`, data: { target: agentId } }] };
    },
  },
  {
    id: 39,
    code: 'A39-VERSOES',
    name: 'Gestor de Versões',
    department: 8,
    responsibility: 'Registra versões do aplicativo, do Node.js e do minerador, e alerta minerador abaixo da versão mínima.',
    mode: 'scheduled',
    intervalMs: 12 * HOUR,
    permissions: ['read:metrics', 'write:metrics', 'emit:alert'],
    inputs: ['miner.version', 'MIN_MINER_VERSION'],
    outputs: ['app.version', 'app.node_version'],
    maturity: 'validado',
    async run(ctx) {
      const mv = ctx.metrics.value('miner.version');
      let note = '';
      if (ctx.config.minMinerVersion && typeof mv === 'string' && compareVersions(mv, ctx.config.minMinerVersion) < 0) {
        note = ` · minerador ${mv} abaixo do mínimo ${ctx.config.minMinerVersion}`;
        ctx.raiseAlert('version.miner_outdated', 'warn', `Minerador ${mv} abaixo da versão mínima ${ctx.config.minMinerVersion}`);
      }
      return {
        status: 'ok',
        summary: `App ${APP_VERSION} · Node ${process.versions.node}${mv ? ` · minerador ${String(mv)}` : ''}${note}`,
        metrics: [metric('app.version', APP_VERSION, 'real', 'app'), metric('app.node_version', process.versions.node, 'real', 'runtime')],
      };
    },
  },
  {
    id: 40,
    code: 'A40-BACKUP',
    name: 'Backup e Retenção',
    department: 8,
    responsibility: 'Faz cópia consistente do banco (VACUUM INTO), mantém as 7 mais recentes e remove registros além do prazo de retenção.',
    mode: 'scheduled',
    intervalMs: 6 * HOUR,
    permissions: ['write:files', 'write:metrics'],
    inputs: ['DB_PATH', 'RETENTION_DAYS'],
    outputs: ['backup.last_at', 'retention.purged'],
    essential: true,
    maturity: 'validado',
    timeoutMs: 120_000,
    async run(ctx) {
      const store = ctx.services.store;
      const purged = store.purgeOlderThan(ctx.now() - ctx.config.retentionDays * 24 * HOUR);
      const total = purged.events + purged.metrics + purged.tasks + purged.executions;
      const out = [metric('retention.purged', total, 'real', 'retenção')];
      let summary = `Retenção: ${total} registro(s) removido(s)`;
      if (ctx.config.dbPath !== ':memory:') {
        const dir = join(ctx.config.dataDir, 'backups');
        const stamp = new Date(ctx.now()).toISOString().replace(/[:T]/g, '-').slice(0, 16);
        store.backupTo(join(dir, `office50-${stamp}.db`));
        const files = readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
        for (const f of files.slice(0, Math.max(0, files.length - 7))) rmSync(join(dir, f));
        out.push(metric('backup.last_at', ctx.now(), 'real', 'backup'));
        summary += ` · backup office50-${stamp}.db`;
      } else summary += ' · banco em memória: backup ignorado';
      return { status: 'ok', summary, metrics: out };
    },
  },
];
