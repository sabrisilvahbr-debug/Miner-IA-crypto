// Pré-condições de um teste curto de mineração. Nada aqui inicia processo: só diz o que falta.
// O teste só começa com TODAS as pré-condições atendidas e a frase de autorização digitada pelo operador.
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
  minerDetail?: string; // por que o minerador foi aceito ou recusado (caminho, SHA-256)
  maxTempC: number;
  criticalTempC: number;
  busy?: boolean; // já há um teste em andamento
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
  const prof = coin?.minerProfile;
  const g = i.gpu.gpus?.[0];
  const addr = i.payoutAddresses[i.req.coin];
  const checks: Check[] = [
    {
      item: 'GPU verificada',
      ok: i.gpu.status === 'ok' && !!g,
      detalhe: g ? `${g.name}, ${g.memoryTotalMiB ?? '?'} MiB, limite ${g.powerLimitW ?? '?'} W (nvidia-smi)` : `${i.gpu.hardware}: ${i.gpu.mensagem}`,
    },
    {
      item: 'GPU abaixo da temperatura máxima',
      ok: g?.temperatureC != null && g.temperatureC < i.maxTempC,
      detalhe: g?.temperatureC != null ? `${g.temperatureC} °C (máximo ${i.maxTempC} °C)` : 'temperatura não lida',
    },
    {
      item: 'Moeda no catálogo com pool e algoritmo confirmados',
      ok: !!coin && coin.status === 'pool_validada' && !!coin.pool,
      detalhe: !coin ? 'moeda fora do catálogo' : coin.status !== 'pool_validada' ? `em investigação: ${coin.pendencias.join('; ')}` : `${coin.algorithm} · ${coin.pool!.stratumUrl}`,
    },
    {
      item: 'Comando do minerador publicado pela pool',
      ok: !!prof,
      detalhe: prof ? `${prof.poolName}: --algorithm ${prof.algorithm} --pool ${prof.poolHostPort} --wallet ${prof.loginFormat} (${prof.sourceUrl})` : 'nenhuma pool publica o comando completo do SRBMiner-MULTI para esta moeda',
    },
    {
      item: 'Compatibilidade do algoritmo com a GPU (indicada por fonte)',
      ok: !!prof,
      detalhe: prof ? prof.compatibilidade : coin ? `sem fonte que indique ${coin.algorithm} nesta GPU` : 'moeda fora do catálogo',
    },
    {
      item: 'Minerador verificado (origem, integridade e integração)',
      ok: i.minerIntegrated,
      detalhe: i.minerDetail ?? (i.minerIntegrated ? 'minerador na lista permitida, com SHA-256 conferido' : 'nenhum minerador configurado'),
    },
    {
      item: 'Pool autorizada no Guardião (ALLOWED_POOLS)',
      ok: !!prof && i.allowedPools.includes(prof.stratumUrl),
      detalhe: prof ? (i.allowedPools.includes(prof.stratumUrl) ? prof.stratumUrl : `adicione ${prof.stratumUrl} em ALLOWED_POOLS`) : 'sem pool para o teste',
    },
    {
      item: 'Endereço público de recebimento informado',
      ok: !!addr && /^[A-Za-z0-9]{20,128}$/.test(addr),
      detalhe: !addr ? `informe PAYOUT_ADDRESS_${i.req.coin} (endereço público; nunca chave privada ou frase-semente)`
        : /^[A-Za-z0-9]{20,128}$/.test(addr) ? `PAYOUT_ADDRESS_${i.req.coin} configurado (${addr.slice(0, 6)}…${addr.slice(-4)})` : `PAYOUT_ADDRESS_${i.req.coin} recusado: só letras e números, 20 a 128 caracteres`,
    },
    {
      item: 'Formato de login/worker documentado pela pool',
      ok: !!prof,
      detalhe: prof ? `${prof.loginFormat}, segundo ${prof.sourceUrl}` : coin?.pendencias.find((p) => /login|worker/.test(p)) ?? 'não verificado',
    },
    {
      item: 'Nenhum outro teste em andamento',
      ok: !i.busy,
      detalhe: i.busy ? 'aguarde o fim do teste atual ou use INTERROMPER' : 'livre',
    },
  ];
  return {
    pronto: checks.every((c) => c.ok),
    checks,
    plano: {
      moeda: i.req.coin,
      duracaoMin: i.req.durationMin,
      limites: { temperaturaMaxC: i.maxTempC, temperaturaCriticaC: i.criticalTempC, potenciaLimiteGpuW: g?.powerLimitW ?? null },
      pool: prof ? { nome: prof.poolName, endereco: prof.stratumUrl, login: prof.loginFormat, taxa: prof.poolFee } : null,
      riscos: [
        'aumento de temperatura e consumo da GPU durante o teste',
        'resultado de poucos minutos não representa a receita diária',
        'a pool pode não registrar shares em um teste curto',
        'o antivírus pode bloquear o minerador; o sistema não desativa nenhuma proteção',
        'a taxa do desenvolvedor do SRBMiner-MULTI para pearlhash não foi confirmada',
      ],
      autorizacao: `digite a frase exata "${AUTH_PHRASE}" para autorizar`,
    },
  };
}
