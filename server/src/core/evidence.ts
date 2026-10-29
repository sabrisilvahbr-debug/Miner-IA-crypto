// Níveis de evidência de mineração. "Mineração ativa" só é declarada com shares aceitas a partir de dados reais.
import type { Metric, Provenance } from './types.ts';

export interface EvidenceStep {
  level: number;
  label: string;
  met: boolean;
  provenance?: Provenance;
  detail: string;
}

export interface MiningEvidence {
  level: number;
  label: string;
  miningActive: boolean;
  simulated: boolean;
  statement: string;
  steps: EvidenceStep[];
}

const FRESH_MS = 5 * 60_000;

export function computeEvidence(get: (key: string) => Metric | undefined, now: number): MiningEvidence {
  const fresh = (m?: Metric) => !!m && now - m.ts < FRESH_MS;
  const connected = get('miner.connected');
  const hashrate = get('miner.hashrate_hs');
  const shares = get('miner.shares_accepted');
  const sharesDelta = get('miner.shares_accepted_delta');
  const poolBalance = get('pool.balance');
  const poolPaid = get('pool.paid_total');
  const received = get('finance.confirmed_received_btc');

  const steps: EvidenceStep[] = [
    {
      level: 1,
      label: 'Conectado ao minerador',
      met: fresh(connected) && connected!.value === true,
      provenance: connected?.provenance,
      detail: connected ? `API do minerador respondeu (${connected.source})` : 'sem resposta do minerador',
    },
    {
      level: 2,
      label: 'Hashrate informado pelo minerador',
      met: fresh(hashrate) && typeof hashrate!.value === 'number' && hashrate!.value > 0,
      provenance: hashrate?.provenance,
      detail: 'valor reportado pelo próprio minerador, não confirmado pela pool',
    },
    {
      level: 3,
      label: 'Shares aceitas pela pool',
      met: fresh(sharesDelta) && typeof sharesDelta!.value === 'number' && sharesDelta!.value > 0,
      provenance: sharesDelta?.provenance ?? shares?.provenance,
      detail: shares ? `total de shares aceitas: ${String(shares.value)}` : 'nenhuma share aceita registrada',
    },
    {
      level: 4,
      label: 'Saldo na pool',
      met: !!poolBalance && typeof poolBalance.value === 'number' && (poolBalance.value > 0 || (typeof poolPaid?.value === 'number' && poolPaid.value > 0)),
      provenance: poolBalance?.provenance,
      detail: poolBalance ? `saldo informado pela pool: ${String(poolBalance.value)}` : 'saldo da pool indisponível',
    },
    {
      level: 5,
      label: 'Pagamento confirmado on-chain',
      met: !!received && typeof received.value === 'number' && received.value > 0,
      provenance: received?.provenance,
      detail: received ? `recebido com confirmação: ${String(received.value)} BTC` : 'nenhum pagamento confirmado',
    },
  ];

  let level = 0;
  for (const s of steps) {
    if (s.met) level = s.level;
    else break;
  }
  const relevant = steps.filter((s) => s.level <= Math.max(level, 1)).map((s) => s.provenance);
  const simulated = relevant.some((p) => p === 'simulado' || p === 'teste');
  const miningActive = level >= 3 && !simulated;
  const label = level === 0 ? 'Desconectado' : steps[level - 1].label;
  let statement: string;
  if (simulated) statement = 'SIMULAÇÃO — nenhum minerador real está sendo medido.';
  else if (miningActive) statement = 'Mineração ativa confirmada por shares aceitas pela pool.';
  else if (level === 2) statement = 'O minerador informa hashrate, mas ainda não há shares aceitas confirmadas.';
  else if (level === 1) statement = 'Conectado ao minerador, sem hashrate informado.';
  else statement = 'Sem conexão com minerador: mineração não confirmada.';
  return { level, label, miningActive, simulated, statement, steps };
}
