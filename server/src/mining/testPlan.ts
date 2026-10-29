// Pré-condições de um teste curto de mineração. Nada aqui inicia processo: só diz o que falta.
import { findCoin } from './catalog.ts';
import type { GpuView } from '../gpu/monitor.ts';

export interface TestRequest {
  coin: string;
  durationMin: number;
}

export interface Check {
  item: string;
  ok: boolean;
  detalhe: string;
}

export interface TestPlanInput {
  req: TestRequest;
  gpu: GpuView;
  allowedPools: string[];
  payoutAddresses: Record<string, string>;
  minerIntegrated: boolean; // existe um minerador verificado e integrado ao supervisor?
  maxTempC: number;
  criticalTempC: number;
}

export const DEFAULT_TEST_MIN = 5;
export const MAX_TEST_MIN = 30;
export const AUTH_PHRASE = 'AUTORIZO TESTE DE MINERAÇÃO';

export function validateTestRequest(body: unknown): TestRequest | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const coin = typeof b.coin === 'string' ? b.coin.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{2,12}$/.test(coin)) return 'moeda inválida';
  const d = b.durationMin === undefined ? DEFAULT_TEST_MIN : Number(b.durationMin);
  if (!Number.isInteger(d) || d < 1 || d > MAX_TEST_MIN) return `duração deve ser um inteiro entre 1 e ${MAX_TEST_MIN} minutos`;
  return { coin, durationMin: d };
}

export function testChecklist(i: TestPlanInput): { pronto: boolean; checks: Check[]; plano: Record<string, unknown> } {
  const coin = findCoin(i.req.coin);
  const g = i.gpu.gpus?.[0];
  const checks: Check[] = [
    {
      item: 'GPU verificada',
      ok: i.gpu.status === 'ok' && !!g,
      detalhe: g ? `${g.name}, ${g.memoryTotalMiB ?? '?'} MiB, limite ${g.powerLimitW ?? '?'} W (nvidia-smi)` : `${i.gpu.hardware}: ${i.gpu.mensagem}`,
    },
    {
      item: 'Moeda no catálogo com pool e algoritmo confirmados',
      ok: !!coin && coin.status === 'pool_validada' && !!coin.pool,
      detalhe: !coin ? 'moeda fora do catálogo' : coin.status !== 'pool_validada' ? `em investigação: ${coin.pendencias.join('; ')}` : `${coin.algorithm} · ${coin.pool!.stratumUrl}`,
    },
    {
      item: 'Compatibilidade do algoritmo com a GPU comprovada',
      ok: false,
      detalhe: coin ? `não comprovada para ${coin.algorithm}: falta minerador documentado para Windows com suporte a esta GPU e requisito de VRAM confirmado` : 'moeda fora do catálogo',
    },
    {
      item: 'Minerador verificado (origem, integridade e integração)',
      ok: i.minerIntegrated,
      detalhe: i.minerIntegrated ? 'minerador na lista permitida, com SHA-256 conferido' : 'NÃO IMPLEMENTADO: nenhum minerador de GPU verificado está integrado',
    },
    {
      item: 'Pool autorizada no Guardião (ALLOWED_POOLS)',
      ok: !!coin?.pool && i.allowedPools.includes(coin.pool.stratumUrl),
      detalhe: coin?.pool ? (i.allowedPools.includes(coin.pool.stratumUrl) ? coin.pool.stratumUrl : `adicione ${coin.pool.stratumUrl} em ALLOWED_POOLS`) : 'sem pool',
    },
    {
      item: 'Endereço público de recebimento informado',
      ok: !!i.payoutAddresses[i.req.coin],
      detalhe: i.payoutAddresses[i.req.coin] ? `PAYOUT_ADDRESS_${i.req.coin} configurado` : `informe PAYOUT_ADDRESS_${i.req.coin} (endereço público; nunca chave privada ou frase-semente)`,
    },
    {
      item: 'Formato de login/worker documentado pela pool',
      ok: false,
      detalhe: coin?.pendencias.find((p) => /login|worker/.test(p)) ?? 'não verificado',
    },
  ];
  return {
    pronto: checks.every((c) => c.ok),
    checks,
    plano: {
      moeda: i.req.coin,
      duracaoMin: i.req.durationMin,
      limites: { temperaturaMaxC: i.maxTempC, temperaturaCriticaC: i.criticalTempC, potenciaLimiteGpuW: g?.powerLimitW ?? null },
      riscos: [
        'aumento de temperatura e consumo da GPU durante o teste',
        'resultado de 5 minutos não representa a receita diária',
        'a pool pode não registrar shares em um teste curto',
      ],
      autorizacao: `envie a frase exata "${AUTH_PHRASE}" para autorizar`,
    },
  };
}
