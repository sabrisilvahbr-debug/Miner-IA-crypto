// Catálogo de moedas candidatas para a GPU do operador (NVIDIA GeForce RTX 3050, 6 GB, limite de 70 W, lido pelo nvidia-smi).
// Somente dados verificados nas fontes indicadas. Fontes de cada item: docs/INTEGRACOES-GPU.md.
// Status:
//  - pool_validada: pool, endereço de stratum, algoritmo, taxa e pagamento mínimo conferidos na página da pool.
//                   Elegível para a SIMULAÇÃO. Ainda falta validar login e software antes de qualquer ativação real.
//  - investigar:    sem pool, minerador ou algoritmo confirmados entre as fontes. Nunca é avaliada para mineração.
// Quando uma moeda for adicionada, registre a URL da fonte e a data da verificação.

export type CoinStatus = 'pool_validada' | 'investigar';

export interface PoolInfo {
  name: string;
  stratumUrl: string; // exatamente como publicado na página da pool
  poolFee: number; // fração (0,01 = 1%)
  minPayout: number; // na unidade da moeda
  sourceUrl: string;
  verifiedAt: string; // AAAA-MM-DD
}

export interface CoinCandidate {
  symbol: string;
  name: string;
  algorithm: string;
  status: CoinStatus;
  pool?: PoolInfo;
  wtmTag?: string; // sigla da moeda na WhatToMine (pode diferir da sigla da pool)
  wtmAlgorithm?: string; // nome do algoritmo na WhatToMine, conferido com a pool
  pendencias: string[]; // o que ainda falta validar
}

const VERIFIED_AT = '2026-10-29';

export const CATALOG: CoinCandidate[] = [
  {
    symbol: 'PRL',
    name: 'Pearl',
    algorithm: 'PearlHash',
    status: 'pool_validada',
    wtmTag: 'PRL',
    wtmAlgorithm: 'Pearl', // 2Miners chama de PearlHash; WhatToMine, de Pearl
    pool: {
      name: '2Miners (PPLNS)',
      stratumUrl: 'stratum+tcp://prl.2miners.com:1818',
      poolFee: 0.01,
      minPayout: 1,
      sourceUrl: 'https://2miners.com/prl-mining-pool',
      verifiedAt: VERIFIED_AT,
    },
    pendencias: [
      'formato de login/worker não publicado na página da 2Miners (a Kryptex documenta WALLET.WORKER para o SRBMiner-MULTI)',
      'compatibilidade com a RTX 3050 de 6 GB não confirmada: as fontes citam "RTX série 2000 e mais novas" e não informam a VRAM mínima',
      'minerador para Windows (SRBMiner-MULTI) citado pela Kryptex, sem fonte oficial de download nem hash publicado verificados',
    ],
  },
  {
    symbol: 'QTC',
    name: 'Quantus',
    algorithm: 'Poseidon2',
    // Rebaixada em 2026-10-29: algoritmo diverge entre as fontes (2Miners: Poseidon2; WhatToMine: QPoW)
    // e, na WhatToMine, a sigla QTC pertence a outra moeda (Qubitcoin). A Quantus aparece como QUANTUS.
    status: 'investigar',
    wtmTag: 'QUANTUS',
    pool: {
      name: '2Miners (PPLNS)',
      stratumUrl: 'stratum+tcp://qtc.2miners.com:3636',
      poolFee: 0.01,
      minPayout: 0.1,
      sourceUrl: 'https://2miners.com/qtc-mining-pool',
      verifiedAt: VERIFIED_AT,
    },
    pendencias: [
      'algoritmo diverge: 2Miners informa Poseidon2, WhatToMine informa QPoW',
      'na WhatToMine a sigla QTC é da Qubitcoin; a Quantus aparece como QUANTUS',
      'formato de login/worker não publicado na página da pool',
      'software de mineração compatível com a RTX 3050 não verificado',
    ],
  },
  {
    symbol: 'EPIC',
    name: 'EPIC',
    algorithm: 'não verificado',
    status: 'investigar',
    pendencias: ['pool não encontrada na lista da 2Miners', 'minerador compatível não verificado', 'documentação não verificada'],
  },
  {
    symbol: 'XTM',
    name: 'Tari',
    algorithm: 'não verificado',
    status: 'investigar',
    pendencias: ['pool não encontrada na lista da 2Miners', 'minerador compatível não verificado', 'documentação não verificada'],
  },
];

export function findCoin(symbol: string): CoinCandidate | undefined {
  return CATALOG.find((c) => c.symbol === symbol.toUpperCase());
}
