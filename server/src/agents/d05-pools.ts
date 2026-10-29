// Departamento 5 — Pools e infraestrutura (agentes 21–25)
import { connect } from 'node:net';
import type { AgentDefinition, MetricInput } from '../core/types.ts';
import { DisconnectedError } from '../core/rateLimiter.ts';
import { HOUR, MIN, SEC, fmtHashrate, metric } from './common.ts';

function tcpLatency(url: string, timeoutMs = 4000): Promise<number> {
  const u = new URL(url.replace(/^stratum\+(tcp|ssl):/, 'tcp:'));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const s = connect({ host: u.hostname, port: Number(u.port || 3333) });
    s.setTimeout(timeoutMs, () => { s.destroy(); reject(new DisconnectedError(`sem resposta de ${u.host}`)); });
    s.on('connect', () => { s.destroy(); resolve(Date.now() - started); });
    s.on('error', (e) => reject(new DisconnectedError(`${u.host}: ${e.message}`)));
  });
}

export const pools: AgentDefinition[] = [
  {
    id: 21,
    code: 'A21-CONECTOR-POOL',
    name: 'Conector de Pools',
    department: 5,
    responsibility: 'Consulta as estatísticas da pool (endpoint JSON configurável) e registra o hashrate visto pela pool.',
    mode: 'scheduled',
    intervalMs: 2 * MIN,
    permissions: ['read:pool', 'write:metrics'],
    inputs: ['POOL_STATS_URL'],
    outputs: ['pool.connected', 'pool.hashrate_hs'],
    maturity: 'simulado',
    async run(ctx) {
      const pool = ctx.services.pool;
      try {
        const s = await pool.stats();
        const out: MetricInput[] = [metric('pool.connected', true, s.provenance, s.source)];
        if (s.hashrateHs !== undefined) out.push(metric('pool.hashrate_hs', s.hashrateHs, s.provenance, s.source, 'H/s'));
        return { status: 'ok', summary: `Pool respondeu${s.hashrateHs ? ` · hashrate na pool ${fmtHashrate(s.hashrateHs)}` : ''}`, metrics: out };
      } catch (e) {
        if (e instanceof DisconnectedError) {
          return { status: 'disconnected', summary: e.message, metrics: [metric('pool.connected', false, pool.provenance, 'pool')], events: [{ type: 'pool.disconnected', severity: 'warn', message: e.message, data: { dedupeKey: 'pool-down' } }] };
        }
        throw e;
      }
    },
  },
  {
    id: 22,
    code: 'A22-SHARES',
    name: 'Monitor de Shares',
    department: 5,
    responsibility: 'Acompanha shares aceitas e rejeitadas informadas pelo minerador; o aumento de shares aceitas é a evidência de mineração ativa.',
    mode: 'continuous',
    intervalMs: 30 * SEC,
    permissions: ['read:miner', 'write:metrics', 'emit:alert'],
    inputs: ['resumo do minerador'],
    outputs: ['miner.shares_accepted', 'miner.shares_rejected', 'miner.shares_accepted_delta', 'miner.reject_rate_pct'],
    maturity: 'simulado',
    async run(ctx) {
      const s = await ctx.services.miner.summary();
      if (s.sharesGood === undefined || s.sharesTotal === undefined) return { status: 'skipped', summary: 'minerador não informa shares' };
      const prev = ctx.memory.prevGood as number | undefined;
      const delta = prev === undefined || s.sharesGood < prev ? 0 : s.sharesGood - prev;
      ctx.memory.prevGood = s.sharesGood;
      const rejected = s.sharesTotal - s.sharesGood;
      const rate = s.sharesTotal > 0 ? (rejected / s.sharesTotal) * 100 : 0;
      if (rate > ctx.config.maxRejectRatePct && s.sharesTotal > 50) ctx.raiseAlert('shares.reject_rate', 'warn', `Taxa de rejeição ${rate.toFixed(2)}%`);
      return {
        status: 'ok',
        summary: `Aceitas ${s.sharesGood} (+${delta}) · rejeitadas ${rejected} (${rate.toFixed(2)}%)`,
        metrics: [
          metric('miner.shares_accepted', s.sharesGood, s.provenance, s.source),
          metric('miner.shares_rejected', rejected, s.provenance, s.source),
          metric('miner.shares_accepted_delta', delta, s.provenance, s.source),
          metric('miner.reject_rate_pct', Math.round(rate * 100) / 100, s.provenance, 'cálculo', '%'),
        ],
      };
    },
  },
  {
    id: 23,
    code: 'A23-SALDO-POOL',
    name: 'Monitor de Saldo na Pool',
    department: 5,
    responsibility: 'Registra o saldo não pago e o total já pago informados pela pool.',
    mode: 'scheduled',
    intervalMs: 10 * MIN,
    permissions: ['read:pool', 'write:metrics'],
    inputs: ['POOL_BALANCE_PATH', 'POOL_PAID_PATH'],
    outputs: ['pool.balance', 'pool.paid_total'],
    maturity: 'simulado',
    async run(ctx) {
      const s = await ctx.services.pool.stats();
      const out: MetricInput[] = [];
      if (s.balance !== undefined) out.push(metric('pool.balance', s.balance, s.provenance, s.source, 'BTC'));
      if (s.paidTotal !== undefined) out.push(metric('pool.paid_total', s.paidTotal, s.provenance, s.source, 'BTC'));
      if (!out.length) return { status: 'skipped', summary: 'pool não informou saldo (verifique POOL_BALANCE_PATH)' };
      return { status: 'ok', summary: `Saldo na pool ${s.balance ?? '?'} · pago ${s.paidTotal ?? '?'}`, metrics: out };
    },
  },
  {
    id: 24,
    code: 'A24-FAILOVER',
    name: 'Recomendador de Failover',
    department: 5,
    responsibility: 'Quando a pool cai, propõe troca para a próxima pool da lista permitida. Nunca troca sozinho.',
    mode: 'event',
    triggers: ['pool.disconnected'],
    permissions: ['read:metrics', 'propose:action', 'emit:alert'],
    inputs: ['pool.disconnected', 'ALLOWED_POOLS'],
    outputs: ['proposta switch_pool'],
    maturity: 'validado',
    async run(ctx) {
      const current = String(ctx.metrics.value('miner.pool_url') ?? '');
      const candidates = ctx.config.allowedPools.filter((p) => p !== current);
      if (!candidates.length) {
        ctx.raiseAlert('pool.no_failover', 'warn', 'Pool indisponível e nenhuma pool alternativa em ALLOWED_POOLS');
        return { status: 'skipped', summary: 'sem pool alternativa configurada' };
      }
      if (ctx.now() - Number(ctx.memory.lastAt ?? 0) < HOUR) return { status: 'skipped', summary: 'proposta recente já existe' };
      ctx.memory.lastAt = ctx.now();
      const a = ctx.proposeAction({ kind: 'switch_pool', params: { pool: candidates[0] }, reason: 'pool atual não respondeu', evidence: ctx.services.pool.provenance });
      return { status: 'ok', summary: `Proposta de troca para ${candidates[0]} (${a.status})` };
    },
  },
  {
    id: 25,
    code: 'A25-REDE',
    name: 'Monitor de Rede e Latência',
    department: 5,
    responsibility: 'Mede a latência TCP até o servidor stratum da pool e acompanha a latência da API do minerador.',
    mode: 'continuous',
    intervalMs: 2 * MIN,
    permissions: ['read:metrics', 'write:metrics', 'emit:alert'],
    inputs: ['POOL_STRATUM_URL', 'net.latency_miner_ms'],
    outputs: ['net.latency_pool_ms'],
    maturity: 'simulado',
    async run(ctx) {
      const url = ctx.config.poolStratumUrl;
      if (!url) {
        const ml = ctx.metrics.get('net.latency_miner_ms');
        return { status: 'skipped', summary: `POOL_STRATUM_URL não configurado${ml ? ` · latência do minerador ${ml.value} ms` : ''}` };
      }
      const ms = await tcpLatency(url);
      if (ms > 500) ctx.raiseAlert('net.latency', 'warn', `Latência até a pool em ${ms} ms`);
      return { status: 'ok', summary: `Latência TCP até a pool: ${ms} ms`, metrics: [metric('net.latency_pool_ms', ms, 'real', 'tcp', 'ms')] };
    },
  },
];
