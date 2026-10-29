// Custo de energia em duas modalidades, sem nunca somá-las.
//  A — informado: custo mensal estimado pelo operador (ENERGY_MONTHLY_COST) ou consumo declarado (POWER_WATTS) × tarifa.
//  B — medido:    potência média da GPU medida pelo nvidia-smi DURANTE uma sessão de mineração × tarifa.
// Consumo em repouso nunca é usado como consumo de mineração. A medição do nvidia-smi é só da GPU, não do computador.
import { energyCostDay } from './profitability.ts';

export type EnergyMode = 'informado' | 'medido' | 'comparar';

export interface EnergyConfig {
  mode: EnergyMode;
  tariffKwh?: number;
  monthlyCostInformed?: number;
  declaredPowerW?: number;
  hoursPerDay: number;
  daysPerMonth: number;
  gpuPowerLimitW?: number; // lido do nvidia-smi, para conferir se o valor informado é plausível
}

export interface MeasuredPower {
  avgW: number;
  samples: number;
  duringMining: boolean;
  fromAt: number;
  toAt: number;
}

export interface EnergyMethod {
  disponivel: boolean;
  motivo?: string;
  diario?: number;
  mensal?: number;
  base: string;
  escopo: string;
}

export interface EnergyReport {
  modo: EnergyMode;
  informado: EnergyMethod;
  medido: EnergyMethod;
  usadoNoLucro: 'informado' | 'medido' | null;
  custoDiario?: number;
  avisos: string[];
}

export const MIN_MINING_SAMPLES = 10;

function costPerDay(watts: number, tariff: number, hours: number): number {
  return energyCostDay(watts, tariff) * (hours / 24);
}

export function energyReport(cfg: EnergyConfig, measured?: MeasuredPower): EnergyReport {
  const avisos: string[] = [];
  const days = cfg.daysPerMonth;

  let informado: EnergyMethod;
  if (cfg.monthlyCostInformed !== undefined && cfg.monthlyCostInformed > 0) {
    const mensal = cfg.monthlyCostInformed;
    informado = { disponivel: true, mensal, diario: mensal / days, base: 'custo mensal estimado informado pelo operador (ENERGY_MONTHLY_COST)', escopo: 'definido pelo operador' };
  } else if (cfg.declaredPowerW !== undefined && cfg.declaredPowerW > 0 && cfg.tariffKwh !== undefined) {
    const diario = costPerDay(cfg.declaredPowerW, cfg.tariffKwh, cfg.hoursPerDay);
    informado = { disponivel: true, diario, mensal: diario * days, base: `consumo declarado (${cfg.declaredPowerW} W) × tarifa ${cfg.tariffKwh}/kWh × ${cfg.hoursPerDay} h/dia`, escopo: 'declarado pelo operador' };
  } else {
    informado = { disponivel: false, motivo: 'nem ENERGY_MONTHLY_COST nem POWER_WATTS + ENERGY_PRICE_KWH foram informados', base: '—', escopo: '—' };
  }

  let medido: EnergyMethod;
  if (!measured) {
    medido = { disponivel: false, motivo: 'nenhuma medição de consumo durante mineração (mineração desativada)', base: '—', escopo: 'somente GPU' };
  } else if (!measured.duringMining) {
    medido = { disponivel: false, motivo: 'leitura feita fora de mineração: consumo em repouso não é usado como consumo de mineração', base: '—', escopo: 'somente GPU' };
  } else if (measured.samples < MIN_MINING_SAMPLES) {
    medido = { disponivel: false, motivo: `poucas amostras durante mineração (${measured.samples} de ${MIN_MINING_SAMPLES})`, base: '—', escopo: 'somente GPU' };
  } else if (cfg.tariffKwh === undefined) {
    medido = { disponivel: false, motivo: 'ENERGY_PRICE_KWH não informado', base: '—', escopo: 'somente GPU' };
  } else {
    const diario = costPerDay(measured.avgW, cfg.tariffKwh, cfg.hoursPerDay);
    medido = { disponivel: true, diario, mensal: diario * days, base: `média medida ${measured.avgW.toFixed(1)} W em ${measured.samples} amostras × tarifa ${cfg.tariffKwh}/kWh × ${cfg.hoursPerDay} h/dia`, escopo: 'somente GPU (não inclui o restante do computador)' };
  }

  if (cfg.gpuPowerLimitW !== undefined && cfg.tariffKwh !== undefined && informado.disponivel && informado.mensal !== undefined) {
    const maxGpu = costPerDay(cfg.gpuPowerLimitW, cfg.tariffKwh, cfg.hoursPerDay) * days;
    if (informado.mensal > maxGpu * 1.05) {
      avisos.push(`o custo informado (${informado.mensal.toFixed(2)}/mês) é maior que o máximo da GPU no limite de ${cfg.gpuPowerLimitW} W (${maxGpu.toFixed(2)}/mês): pode incluir o computador inteiro ou ter sido calculado para outra placa`);
    }
  }
  if (cfg.declaredPowerW !== undefined && cfg.gpuPowerLimitW !== undefined && cfg.declaredPowerW > cfg.gpuPowerLimitW) {
    avisos.push(`POWER_WATTS (${cfg.declaredPowerW} W) é maior que o limite de potência da GPU (${cfg.gpuPowerLimitW} W)`);
  }

  let usado: 'informado' | 'medido' | null = null;
  if (cfg.mode === 'informado') usado = informado.disponivel ? 'informado' : null;
  else if (cfg.mode === 'medido') usado = medido.disponivel ? 'medido' : null;
  else usado = medido.disponivel ? 'medido' : informado.disponivel ? 'informado' : null;

  const custoDiario = usado === 'medido' ? medido.diario : usado === 'informado' ? informado.diario : undefined;
  return { modo: cfg.mode, informado, medido, usadoNoLucro: usado, custoDiario, avisos };
}
