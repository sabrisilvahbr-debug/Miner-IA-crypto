// Catálogo de moedas candidatas para a GPU (RTX 3060). Somente dados verificados em fontes oficiais.
// Status:
//  - pool_validada: pool, endereço de stratum, algoritmo, taxa e pagamento mínimo conferidos na página da pool.
//                   Elegível para a SIMULAÇÃO. Ainda falta validar login e software antes de qualquer ativação real.
//  - investigar:    listada pelo operador, mas sem pool e minerador verificados. Nunca é avaliada para mineração.
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
  pendencias: string[]; // o que ainda falta validar
}

const VERIFIED_AT = '2026-10-29';

export const CATALOG: CoinCandidate[] = [
  {
    symbol: 'PRL',
    name: 'Pearl',
    algorithm: 'PearlHash',
    status: 'pool_validada',
    pool: {
      name: '2Miners (PPLNS)',
      stratumUrl: 'stratum+tcp://prl.2miners.com:1818',
      poolFee: 0.01,
      minPayout: 1,
      sourceUrl: 'https://2miners.com/prl-mining-pool',
      verifiedAt: VERIFIED_AT,
    },
    pendencias: [
      'formato de login/worker não publicado na página da pool',
      'software de mineração compatível com PearlHash na RTX 3060 não verificado',
    ],
  },
  {
    symbol: 'QTC',
    name: 'Quantus',
    algorithm: 'Poseidon2',
    status: 'pool_validada',
    pool: {
      name: '2Miners (PPLNS)',
      stratumUrl: 'stratum+tcp://qtc.2miners.com:3636',
      poolFee: 0.01,
      minPayout: 0.1,
      sourceUrl: 'https://2miners.com/qtc-mining-pool',
      verifiedAt: VERIFIED_AT,
    },
    pendencias: [
      'formato de login/worker não publicado na página da pool',
      'software de mineração compatível com Poseidon2 na RTX 3060 não verificado',
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
