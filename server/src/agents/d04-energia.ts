// Departamento 4 — Rentabilidade e energia (agentes 16–20)
// Todo valor de rentabilidade é ESTIMATIVA. Nenhum agente promete retorno.
import type { AgentDefinition, AgentContext, Provenance } from '../core/types.ts';
import { HOUR, MIN, asEstimate, expectedBtcPerDay, metric } from './common.ts';

interface Inputs {
  hashrate: number; difficulty: number; subsidy: number; priceLocal: number; powerW?: number; tariff?: number; prov: Provenance; missing: string[];
}

function gather(ctx: AgentContext): Inputs {
  const m = ctx.metrics;
  const local = ctx.config.localCurrency;
  const missing: string[] = [];
  const hr = m.get('miner.hashrate_15m_hs') ?? m.get('miner.hashrate_hs');
  const diff = m.get('network.difficulty');
  const sub = m.get('network.block_subsidy_btc');
  const price = m.get(`price.BTC-${local}`);
  const power = m.get('energy.power_w');
  const tariff = m.get('energy.tariff_kwh');
  if (!hr) missing.push('hashrate');
  if (!diff) missing.push('dificuldade');
  if (!sub) missing.push('recompensa de bloco');
  if (!price) missing.push(`preço BTC-${local}`);
  return {
    hashrate: Number(hr?.value ?? 0), difficulty: Number(diff?.value ?? 0), subsidy: Number(sub?.value ?? 0),
    priceLocal: Number(price?.value ?? 0), powerW: power ? Number(power.value) : undefined, tariff: tariff ? Number(tariff.value) : undefined,
    prov: asEstimate(hr?.provenance, diff?.provenance, sub?.provenance, price?.provenance, power?.provenance, tariff?.provenance),
    missing,
  };
}

const isSha = (ctx: AgentContext) => String(ctx.metrics.value('miner.algo') ?? ctx.config.minerAlgo).toLowerCase().startsWith('sha256');

export const energia: AgentDefinition[] = [
  {
    id: 16,
    code: 'A16-CONSUMO',
    name: 'Medidor de Consumo',
    department: 4,
    responsibility: 'Registra a potência do equipamento: medida pelo minerador quando disponível; caso contrário, o valor declarado em POWER_WATTS (estimado).',
    mode: 'continuous',
    intervalMs: MIN,
    permissions: ['read:miner', 'write:metrics'],
    inputs: ['resumo do minerador', 'POWER_WATTS'],
    outputs: ['energy.power_w', 'energy.kwh_day'],
    maturity: 'simulado',
    async run(ctx) {
      let watts: number | undefined;
      let prov: Provenance = 'estimado';
      let source = 'declarado pelo operador';
      try {
        const s = await ctx.services.miner.summary();
        if (s.powerW !== undefined) { watts = s.powerW; prov = s.provenance; source = s.source; }
      } catch { /* sem minerador: usa o valor declarado */ }
      if (watts === undefined && ctx.config.powerWatts !== undefined) watts = ctx.config.powerWatts;
      if (watts === undefined) return { status: 'skipped', summary: 'potência desconhecida: informe POWER_WATTS' };
      return {
        status: 'ok',
        summary: `${watts} W (${prov}) · ${((watts * 24) / 1000).toFixed(2)} kWh/dia`,
        metrics: [metric('energy.power_w', watts, prov, source, 'W'), metric('energy.kwh_day', (watts * 24) / 1000, prov === 'real' ? 'estimado' : prov, 'cálculo', 'kWh')],
      };
    },
  },
  {
    id: 17,
    code: 'A17-TARIFA',
    name: 'Gestor de Tarifa de Energia',
    department: 4,
    responsibility: 'Publica a tarifa de energia informada pelo operador (ENERGY_PRICE_KWH) para os cálculos de custo.',
    mode: 'scheduled',
    intervalMs: 6 * HOUR,
    permissions: ['write:metrics'],
    inputs: ['ENERGY_PRICE_KWH'],
    outputs: ['energy.tariff_kwh'],
    maturity: 'validado',
    async run(ctx) {
      const c = ctx.config;
      if (c.energyPriceKwh !== undefined) {
        return { status: 'ok', summary: `Tarifa ${c.energyPriceKwh} ${c.localCurrency}/kWh (declarada)`, metrics: [metric('energy.tariff_kwh', c.energyPriceKwh, 'estimado', 'declarado pelo operador', `${c.localCurrency}/kWh`)] };
      }
      if (c.minerType === 'simulated') {
        return { status: 'ok', summary: 'Tarifa simulada 0,85/kWh', metrics: [metric('energy.tariff_kwh', 0.85, 'simulado', 'simulador', `${c.localCurrency}/kWh`)] };
      }
      return { status: 'skipped', summary: 'ENERGY_PRICE_KWH não informado' };
    },
  },
  {
    id: 18,
    code: 'A18-RENTABILIDADE',
    name: 'Calculadora de Rentabilidade',
    department: 4,
    responsibility: 'Estima receita, custo de energia e resultado diário para mineração SHA-256 (Bitcoin). Sempre marcado como estimativa.',
    mode: 'scheduled',
    intervalMs: 5 * MIN,
    permissions: ['read:metrics', 'write:metrics'],
    inputs: ['hashrate', 'dificuldade', 'recompensa', 'preço', 'potência', 'tarifa'],
    outputs: ['profit.btc_day', 'profit.revenue_day', 'profit.energy_cost_day', 'profit.net_day'],
    maturity: 'validado',
    async run(ctx) {
      if (!isSha(ctx)) return { status: 'skipped', summary: 'algoritmo não SHA-256: sem fonte de dificuldade para estimar receita' };
      const i = gather(ctx);
      if (i.missing.length) return { status: 'skipped', summary: `dados insuficientes: ${i.missing.join(', ')}` };
      const btcDay = expectedBtcPerDay(i.hashrate, i.difficulty, i.subsidy);
      const revenue = btcDay * i.priceLocal;
      const cur = ctx.config.localCurrency;
      const out = [metric('profit.btc_day', btcDay, i.prov, 'estimativa', 'BTC'), metric('profit.revenue_day', revenue, i.prov, 'estimativa', cur)];
      let summary = `Receita estimada ${revenue.toFixed(2)} ${cur}/dia (${btcDay.toFixed(8)} BTC), antes de taxas da pool`;
      if (i.powerW !== undefined && i.tariff !== undefined) {
        const cost = ((i.powerW * 24) / 1000) * i.tariff;
        out.push(metric('profit.energy_cost_day', cost, i.prov, 'estimativa', cur), metric('profit.net_day', revenue - cost, i.prov, 'estimativa', cur));
        summary += ` · energia ${cost.toFixed(2)} · resultado ${(revenue - cost).toFixed(2)} ${cur}/dia`;
      }
      return { status: 'ok', summary, metrics: out };
    },
  },
  {
    id: 19,
    code: 'A19-COMPARADOR',
    name: 'Comparador de Viabilidade',
    department: 4,
    responsibility: 'Calcula pontos de equilíbrio: tarifa máxima e preço mínimo do BTC em que a mineração cobre a energia.',
    mode: 'scheduled',
    intervalMs: HOUR,
    permissions: ['read:metrics', 'write:metrics'],
    inputs: ['estimativas de rentabilidade'],
    outputs: ['profit.breakeven_tariff', 'profit.breakeven_btc_price'],
    maturity: 'validado',
    async run(ctx) {
      if (!isSha(ctx)) return { status: 'skipped', summary: 'comparação disponível apenas para SHA-256' };
      const i = gather(ctx);
      if (i.missing.length || i.powerW === undefined || !(i.powerW > 0)) return { status: 'skipped', summary: 'dados insuficientes para ponto de equilíbrio' };
      const btcDay = expectedBtcPerDay(i.hashrate, i.difficulty, i.subsidy);
      const kwhDay = (i.powerW * 24) / 1000;
      const beTariff = (btcDay * i.priceLocal) / kwhDay;
      const out = [metric('profit.breakeven_tariff', beTariff, i.prov, 'estimativa', `${ctx.config.localCurrency}/kWh`)];
      if (i.tariff !== undefined && btcDay > 0) out.push(metric('profit.breakeven_btc_price', (kwhDay * i.tariff) / btcDay, i.prov, 'estimativa', ctx.config.localCurrency));
      return { status: 'ok', summary: `Tarifa de equilíbrio ${beTariff.toFixed(3)} ${ctx.config.localCurrency}/kWh`, metrics: out };
    },
  },
  {
    id: 20,
    code: 'A20-PROJECAO',
    name: 'Projeção de Custos',
    department: 4,
    responsibility: 'Projeta 30 dias de custo de energia e receita, aplicando o próximo ajuste de dificuldade estimado.',
    mode: 'scheduled',
    intervalMs: HOUR,
    permissions: ['read:metrics', 'write:metrics'],
    inputs: ['estimativas diárias', 'network.difficulty_change_pct'],
    outputs: ['profit.month_energy_cost', 'profit.month_revenue'],
    maturity: 'validado',
    async run(ctx) {
      const rev = ctx.metrics.get('profit.revenue_day');
      const cost = ctx.metrics.get('profit.energy_cost_day');
      if (!rev && !cost) return { status: 'skipped', summary: 'sem estimativas diárias' };
      const adj = ctx.metrics.num('network.difficulty_change_pct') ?? 0;
      const revMonth = rev ? (Number(rev.value) * 15) + (Number(rev.value) / (1 + adj / 100)) * 15 : undefined;
      const out = [];
      if (cost) out.push(metric('profit.month_energy_cost', Number(cost.value) * 30, cost.provenance, 'projeção', ctx.config.localCurrency));
      if (revMonth !== undefined) out.push(metric('profit.month_revenue', revMonth, rev!.provenance, 'projeção', ctx.config.localCurrency));
      return { status: 'ok', summary: `Projeção 30 dias: receita ${revMonth?.toFixed(2) ?? '?'} · energia ${cost ? (Number(cost.value) * 30).toFixed(2) : '?'} ${ctx.config.localCurrency}`, metrics: out };
    },
  },
];
