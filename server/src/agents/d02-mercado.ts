// Departamento 2 — Inteligência de mercado (agentes 6–10)
import type { AgentDefinition, MetricInput } from '../core/types.ts';
import { MIN, blockSubsidyBtc, metric, stdev } from './common.ts';

export const mercado: AgentDefinition[] = [
  {
    id: 6,
    code: 'A06-PRECOS',
    name: 'Coletor de Preços',
    department: 2,
    responsibility: 'Coleta cotações à vista dos pares configurados (API pública da Coinbase ou simulador).',
    mode: 'scheduled',
    intervalMs: 2 * MIN,
    permissions: ['read:market', 'write:metrics'],
    inputs: ['PRICE_PAIRS', 'API de mercado'],
    outputs: ['price.<PAR>'],
    maturity: 'simulado',
    async run(ctx) {
      const market = ctx.services.market;
      const out: MetricInput[] = [];
      const errors: string[] = [];
      for (const pair of ctx.config.pricePairs) {
        try {
          const q = await market.quote(pair);
          out.push(metric(`price.${pair}`, q.price, q.provenance, q.source, pair.split('-')[1]));
        } catch (e) {
          errors.push(`${pair}: ${(e as Error).message}`);
          if (errors.length === ctx.config.pricePairs.length) throw e;
        }
      }
      return { status: 'ok', summary: `${out.length} cotação(ões) coletada(s)${errors.length ? ` · falhas: ${errors.join('; ')}` : ''}`, metrics: out };
    },
  },
  {
    id: 7,
    code: 'A07-DIFICULDADE',
    name: 'Monitor de Dificuldade',
    department: 2,
    responsibility: 'Acompanha dificuldade, hashrate da rede Bitcoin e a próxima reavaliação de dificuldade.',
    mode: 'scheduled',
    intervalMs: 15 * MIN,
    permissions: ['read:market', 'write:metrics'],
    inputs: ['API de rede (mempool.space)'],
    outputs: ['network.difficulty', 'network.hashrate_hs', 'network.difficulty_change_pct', 'network.remaining_blocks'],
    maturity: 'simulado',
    async run(ctx) {
      const n = await ctx.services.network.info();
      const out: MetricInput[] = [];
      if (n.difficulty) out.push(metric('network.difficulty', n.difficulty, n.provenance, n.source));
      if (n.networkHashrateHs) out.push(metric('network.hashrate_hs', n.networkHashrateHs, n.provenance, n.source, 'H/s'));
      if (Number.isFinite(n.difficultyChangePct)) out.push(metric('network.difficulty_change_pct', n.difficultyChangePct!, 'estimado', n.source, '%'));
      if (Number.isFinite(n.remainingBlocks)) out.push(metric('network.remaining_blocks', n.remainingBlocks!, n.provenance, n.source));
      if (n.height) out.push(metric('network.height', n.height, n.provenance, n.source));
      return { status: 'ok', summary: `Dificuldade ${n.difficulty?.toExponential(3) ?? 'indisponível'} · próximo ajuste estimado ${n.difficultyChangePct?.toFixed(2) ?? '?'}%`, metrics: out };
    },
  },
  {
    id: 8,
    code: 'A08-RECOMPENSA',
    name: 'Monitor de Recompensa de Bloco',
    department: 2,
    responsibility: 'Calcula a recompensa por bloco e os blocos restantes até o próximo halving a partir da altura da rede.',
    mode: 'event',
    triggers: ['metric.network.height'],
    permissions: ['read:metrics', 'write:metrics'],
    inputs: ['network.height'],
    outputs: ['network.block_subsidy_btc', 'network.blocks_to_halving'],
    maturity: 'validado',
    async run(ctx) {
      const h = ctx.metrics.get('network.height');
      if (!h || typeof h.value !== 'number') return { status: 'skipped', summary: 'altura da rede indisponível' };
      const subsidy = blockSubsidyBtc(h.value);
      const toHalving = 210_000 - (h.value % 210_000);
      return {
        status: 'ok',
        summary: `Recompensa ${subsidy} BTC · ${toHalving} blocos até o halving`,
        metrics: [metric('network.block_subsidy_btc', subsidy, h.provenance, 'regra de consenso', 'BTC'), metric('network.blocks_to_halving', toHalving, h.provenance, 'regra de consenso')],
      };
    },
  },
  {
    id: 9,
    code: 'A09-VOLATILIDADE',
    name: 'Analista de Volatilidade',
    department: 2,
    responsibility: 'Mede a volatilidade recente do preço do BTC (desvio-padrão dos retornos) e alerta em oscilações fortes.',
    mode: 'event',
    triggers: ['metric.price.BTC-USD'],
    permissions: ['read:metrics', 'write:metrics', 'emit:alert'],
    inputs: ['histórico de price.BTC-USD'],
    outputs: ['market.volatility_pct'],
    maturity: 'validado',
    async run(ctx) {
      const hist = ctx.metrics.history('price.BTC-USD', 60).filter((m) => typeof m.value === 'number');
      if (hist.length < 5) return { status: 'skipped', summary: `amostras insuficientes (${hist.length}/5)` };
      const values = hist.map((m) => m.value as number);
      const returns = values.slice(1).map((v, i) => (v - values[i]) / values[i]);
      const vol = stdev(returns) * 100;
      const prov = hist.some((m) => m.provenance === 'simulado') ? 'simulado' : 'estimado';
      if (vol > 1.5) ctx.raiseAlert('market.volatility', 'warn', `Volatilidade elevada do BTC: ${vol.toFixed(2)}% por intervalo`);
      return { status: 'ok', summary: `Volatilidade ${vol.toFixed(3)}% (${hist.length} amostras)`, metrics: [metric('market.volatility_pct', Math.round(vol * 1000) / 1000, prov, 'cálculo', '%')] };
    },
  },
  {
    id: 10,
    code: 'A10-TAXAS',
    name: 'Monitor de Taxas de Rede',
    department: 2,
    responsibility: 'Acompanha as taxas recomendadas da rede Bitcoin (sat/vB), relevantes para pagamentos de pool.',
    mode: 'scheduled',
    intervalMs: 10 * MIN,
    permissions: ['read:market', 'write:metrics'],
    inputs: ['API de rede (mempool.space)'],
    outputs: ['network.fee_fastest', 'network.fee_hour', 'network.fee_economy'],
    maturity: 'simulado',
    async run(ctx) {
      const f = await ctx.services.network.fees();
      return {
        status: 'ok',
        summary: `Taxas: rápida ${f.fastest} · 1h ${f.hour} · econômica ${f.economy} sat/vB`,
        metrics: [
          metric('network.fee_fastest', f.fastest, f.provenance, f.source, 'sat/vB'),
          metric('network.fee_hour', f.hour, f.provenance, f.source, 'sat/vB'),
          metric('network.fee_economy', f.economy, f.provenance, f.source, 'sat/vB'),
        ],
      };
    },
  },
];
