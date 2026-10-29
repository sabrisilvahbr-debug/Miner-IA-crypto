// Gerador determinístico para o modo de simulação. Todo dado gerado aqui é etiquetado "simulado".

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ruído suave e reprodutível em função do tempo (sem estado). */
export function wave(t: number, periodMs: number, seed = 1): number {
  const x = (t / periodMs) * Math.PI * 2;
  return Math.sin(x + seed) * 0.6 + Math.sin(x * 2.7 + seed * 3) * 0.3 + Math.sin(x * 7.1 + seed * 5) * 0.1;
}

export const SIM_EPOCH = Date.UTC(2026, 0, 1);
