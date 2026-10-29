// Departamento 3 — Mineração e hardware (agentes 11–15)
import type { AgentDefinition, MetricInput } from '../core/types.ts';
import { HOUR, SEC, fmtHashrate, median, metric } from './common.ts';

export const mineracao: AgentDefinition[] = [
  {
    id: 11,
    code: 'A11-CONECTOR-MINER',
    name: 'Conector de Mineradores',
    department: 3,
    responsibility: 'Mantém a conexão com a API do minerador (XMRig, cgminer ou simulador) e registra versão, pool e tempo ativo.',
    mode: 'continuous',
    intervalMs: 15 * SEC,
    permissions: ['read:miner', 'write:metrics'],
    inputs: ['MINER_TYPE', 'MINER_URL'],
    outputs: ['miner.connected', 'miner.version', 'miner.pool_url', 'miner.uptime_s'],
    maturity: 'simulado',
    async run(ctx) {
      try {
        const s = await ctx.services.miner.summary();
        const out: MetricInput[] = [metric('miner.connected', true, s.provenance, s.source)];
        if (s.version) out.push(metric('miner.version', s.version, s.provenance, s.source));
        if (s.poolUrl) out.push(metric('miner.pool_url', s.poolUrl, s.provenance, s.source));
        if (s.uptimeS !== undefined) out.push(metric('miner.uptime_s', s.uptimeS, s.provenance, s.source, 's'));
        if (s.latencyMs !== undefined) out.push(metric('net.latency_miner_ms', s.latencyMs, s.provenance, s.source, 'ms'));
        return { status: 'ok', summary: `Conectado (${s.source}${s.version ? ' ' + s.version : ''})`, metrics: out };
      } catch (e) {
        return { status: 'disconnected', summary: (e as Error).message, metrics: [metric('miner.connected', false, ctx.services.miner.adapter.provenance, ctx.services.miner.adapter.type)] };
      }
    },
  },
  {
    id: 12,
    code: 'A12-HASHRATE',
    name: 'Leitor de Hashrate',
    department: 3,
    responsibility: 'Lê o hashrate informado pelo minerador (curto e 15 min). Não é confirmação da pool.',
    mode: 'continuous',
    intervalMs: 15 * SEC,
    permissions: ['read:miner', 'write:metrics'],
    inputs: ['resumo do minerador'],
    outputs: ['miner.hashrate_hs', 'miner.hashrate_15m_hs'],
    maturity: 'simulado',
    async run(ctx) {
      const s = await ctx.services.miner.summary();
      if (s.hashrateHs === undefined) return { status: 'skipped', summary: 'minerador não informou hashrate' };
      const out = [metric('miner.hashrate_hs', s.hashrateHs, s.provenance, s.source, 'H/s')];
      if (s.hashrate15mHs !== undefined) out.push(metric('miner.hashrate_15m_hs', s.hashrate15mHs, s.provenance, s.source, 'H/s'));
      return { status: 'ok', summary: `Hashrate informado: ${fmtHashrate(s.hashrateHs)}`, metrics: out };
    },
  },
  {
    id: 13,
    code: 'A13-TERMICO',
    name: 'Monitor Térmico',
    department: 3,
    responsibility: 'Registra a temperatura informada pelo hardware e alerta acima dos limites configurados.',
    mode: 'continuous',
    intervalMs: 30 * SEC,
    permissions: ['read:miner', 'write:metrics', 'emit:alert'],
    inputs: ['resumo do minerador', 'MAX_TEMP_C', 'CRITICAL_TEMP_C'],
    outputs: ['miner.temperature_c'],
    essential: true,
    maturity: 'simulado',
    async run(ctx) {
      const s = await ctx.services.miner.summary();
      if (s.temperatureC === null || s.temperatureC === undefined) {
        return { status: 'skipped', summary: 'o minerador não expõe sensor de temperatura nesta API' };
      }
      const t = s.temperatureC;
      if (t >= ctx.config.criticalTempC) ctx.raiseAlert('temp.critical', 'critical', `Temperatura crítica: ${t} °C`);
      else if (t >= ctx.config.maxTempC) ctx.raiseAlert('temp.high', 'warn', `Temperatura elevada: ${t} °C`);
      return { status: 'ok', summary: `Temperatura ${t} °C`, metrics: [metric('miner.temperature_c', t, s.provenance, s.source, '°C')] };
    },
  },
  {
    id: 14,
    code: 'A14-INVENTARIO',
    name: 'Inventário de Hardware',
    department: 3,
    responsibility: 'Registra o hardware, o algoritmo e as threads informados pelo minerador.',
    mode: 'scheduled',
    intervalMs: HOUR,
    permissions: ['read:miner', 'write:metrics'],
    inputs: ['resumo do minerador'],
    outputs: ['miner.hardware', 'miner.algo', 'miner.threads'],
    maturity: 'simulado',
    async run(ctx) {
      const s = await ctx.services.miner.summary();
      const out: MetricInput[] = [];
      if (s.hardware) out.push(metric('miner.hardware', s.hardware, s.provenance, s.source));
      if (s.algo) out.push(metric('miner.algo', s.algo, s.provenance, s.source));
      if (s.threads !== undefined) out.push(metric('miner.threads', s.threads, s.provenance, s.source));
      return { status: 'ok', summary: `${s.hardware ?? 'hardware não informado'} · algoritmo ${s.algo ?? '?'}`, metrics: out };
    },
  },
  {
    id: 15,
    code: 'A15-ANOMALIAS',
    name: 'Detector de Anomalias de Desempenho',
    department: 3,
    responsibility: 'Compara o hashrate atual com a mediana recente; em queda forte, alerta e propõe reinício (sujeito ao Guardião e ao operador).',
    mode: 'event',
    triggers: ['metric.miner.hashrate_hs'],
    permissions: ['read:metrics', 'emit:alert', 'propose:action', 'write:metrics'],
    inputs: ['histórico de miner.hashrate_hs'],
    outputs: ['miner.hashrate_deviation_pct', 'proposta restart_miner'],
    maturity: 'validado',
    async run(ctx) {
      const hist = ctx.metrics.history('miner.hashrate_hs', 40).filter((m) => typeof m.value === 'number');
      if (hist.length < 10) return { status: 'skipped', summary: `amostras insuficientes (${hist.length}/10)` };
      const cur = hist[hist.length - 1];
      const base = median(hist.slice(0, -1).map((m) => m.value as number));
      if (!(base > 0)) return { status: 'skipped', summary: 'linha de base nula' };
      const dev = (((cur.value as number) - base) / base) * 100;
      const out = [metric('miner.hashrate_deviation_pct', Math.round(dev * 10) / 10, cur.provenance, 'cálculo', '%')];
      if (dev <= -30) {
        const last = Number(ctx.memory.lastProposalAt ?? 0);
        ctx.raiseAlert('hashrate.drop', 'warn', `Hashrate ${dev.toFixed(1)}% abaixo da mediana recente`);
        if (ctx.now() - last > HOUR) {
          ctx.memory.lastProposalAt = ctx.now();
          ctx.proposeAction({ kind: 'restart_miner', params: {}, reason: `queda de ${dev.toFixed(1)}% no hashrate informado`, evidence: cur.provenance });
        }
      }
      return { status: 'ok', summary: `Desvio do hashrate: ${dev.toFixed(1)}%`, metrics: out };
    },
  },
];
