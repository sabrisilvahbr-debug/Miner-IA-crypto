// Utilidades compartilhadas pelos módulos de agentes.
import type { Department, MetricInput, MetricValue, Provenance } from '../core/types.ts';

export const DEPARTMENTS: Department[] = [
  { id: 1, code: 'DIR', name: 'Direção e coordenação', color: '#d4a64a' },
  { id: 2, code: 'MKT', name: 'Inteligência de mercado', color: '#4aa3d4' },
  { id: 3, code: 'HW', name: 'Mineração e hardware', color: '#e07a3f' },
  { id: 4, code: 'NRG', name: 'Rentabilidade e energia', color: '#7cc46a' },
  { id: 5, code: 'POOL', name: 'Pools e infraestrutura', color: '#8a7cf0' },
  { id: 6, code: 'RISK', name: 'Risco e segurança', color: '#e0525a' },
  { id: 7, code: 'AI', name: 'Estratégia e inteligência artificial', color: '#d36ac8' },
  { id: 8, code: 'OPS', name: 'Automação e manutenção', color: '#4fc1b0' },
  { id: 9, code: 'AUD', name: 'Auditoria e finanças', color: '#c9b458' },
  { id: 10, code: 'COM', name: 'Comunicação e controle', color: '#6c8fd8' },
];

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;

export function metric(key: string, value: MetricValue, provenance: Provenance, source: string, unit?: string): MetricInput {
  return { key, value, provenance, source, unit };
}

/** Procedência combinada: a mais fraca prevalece (teste < simulado < estimado < real). */
export function weakest(...ps: (Provenance | undefined)[]): Provenance {
  const order: Provenance[] = ['teste', 'simulado', 'estimado', 'real'];
  let idx = 3;
  for (const p of ps) if (p) idx = Math.min(idx, order.indexOf(p));
  return order[idx];
}

/** Uma estimativa nunca é "real": dados reais combinados viram "estimado". */
export function asEstimate(...ps: (Provenance | undefined)[]): Provenance {
  const w = weakest(...ps);
  return w === 'real' ? 'estimado' : w;
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}

export function fmtHashrate(hs: number): string {
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
  let i = 0;
  let v = hs;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^[^\d]*/, '').split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^[^\d]*/, '').split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Recompensa por bloco do Bitcoin em BTC, a partir da altura (regra de halving a cada 210.000 blocos). */
export function blockSubsidyBtc(height: number): number {
  const halvings = Math.floor(height / 210_000);
  return halvings >= 64 ? 0 : 50 / 2 ** halvings;
}

/** Receita esperada (BTC/dia) para hashrate SHA-256: hashrate / (dificuldade · 2^32) · 86400 · recompensa. */
export function expectedBtcPerDay(hashrateHs: number, difficulty: number, subsidyBtc: number, avgFeesBtcPerBlock = 0): number {
  if (!(hashrateHs > 0) || !(difficulty > 0)) return 0;
  const blocksPerDay = (hashrateHs * 86_400) / (difficulty * 2 ** 32);
  return blocksPerDay * (subsidyBtc + avgFeesBtcPerBlock);
}
