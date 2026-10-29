// Cálculo de lucro líquido em moeda local (BRL). Funções puras, sem rede e sem efeitos colaterais.
// Entradas que não existem ou estão antigas retornam "indisponível", nunca um número inventado.

export const MIN_MS = 60_000;
export const DAY_MS = 24 * 60 * MIN_MS;

export interface MarketQuote {
  symbol: string;
  revenueLocalDay: number; // receita bruta da GPU em BRL/dia, vinda de fonte externa
  coinsPerDay: number; // moedas/dia estimadas para o hashrate (já é a receita antes das taxas da pool)
  collectedAt: number; // epoch ms de quando o dado foi obtido
  source: string; // nome da fonte, ex.: "whattomine", "manual"
}

export interface EnergyInput {
  powerW: number; // consumo usado no cálculo (medido ou estimado)
  powerIsMeasured: boolean;
  tariffKwh: number; // R$/kWh
}

export interface NetResult {
  grossDay: number;
  energyDay: number;
  poolFeeDay: number;
  minerFeeDay: number;
  netDay: number;
}

export function isFresh(collectedAt: number, now: number, maxAgeMs = 15 * MIN_MS): boolean {
  return now - collectedAt >= 0 && now - collectedAt <= maxAgeMs;
}

export function energyCostDay(powerW: number, tariffKwh: number): number {
  return (powerW / 1000) * 24 * tariffKwh;
}

export function netDay(revenueLocalDay: number, poolFee: number, energy: EnergyInput, minerFee = 0): NetResult {
  const energyDay = energyCostDay(energy.powerW, energy.tariffKwh);
  const poolFeeDay = revenueLocalDay * poolFee;
  const minerFeeDay = revenueLocalDay * minerFee;
  return {
    grossDay: revenueLocalDay,
    energyDay,
    poolFeeDay,
    minerFeeDay,
    netDay: revenueLocalDay - poolFeeDay - minerFeeDay - energyDay,
  };
}

/** Dias até atingir o pagamento mínimo, usando moedas/dia líquidas da taxa da pool. Infinito se não há produção. */
export function daysToPayout(coinsPerDay: number, poolFee: number, minPayout: number): number {
  const net = coinsPerDay * (1 - poolFee);
  if (!(net > 0)) return Number.POSITIVE_INFINITY;
  return minPayout / net;
}
