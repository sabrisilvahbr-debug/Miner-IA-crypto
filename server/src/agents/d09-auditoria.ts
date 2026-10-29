// Departamento 9 — Auditoria e finanças (agentes 41–45)
// Receita só é contabilizada quando há pagamento confirmado. Carteira é monitorada apenas em modo leitura.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDefinition } from '../core/types.ts';
import type { Store } from '../core/store.ts';
import { HOUR, MIN, metric, weakest } from './common.ts';

const AUDITED = ['action.%', 'system.%', 'alert.raised'];
const GENESIS = '0'.repeat(64);

export function auditHash(prevHash: string, ts: number, type: string, payloadJson: string): string {
  return createHash('sha256').update(`${prevHash}|${ts}|${type}|${payloadJson}`).digest('hex');
}

export function verifyAuditChain(store: Store): { ok: boolean; records: number; brokenAt?: number } {
  let prev = GENESIS;
  const rows = store.listAudit(100_000);
  for (const r of rows) {
    if (r.prevHash !== prev || auditHash(r.prevHash, r.ts, r.type, r.payloadJson) !== r.hash) return { ok: false, records: rows.length, brokenAt: r.seq };
    prev = r.hash;
  }
  return { ok: true, records: rows.length };
}

/** CSV de recebimentos confirmados (cada aumento do total recebido vira uma linha). */
export function buildReceiptsCsv(store: Store, currency: string): string {
  const hist = store.metricHistory('finance.confirmed_received_btc', 100_000);
  const lines = ['data_utc;btc_recebido;preco_btc_' + currency.toLowerCase() + ';valor_' + currency.toLowerCase() + ';procedencia'];
  let prev: number | undefined;
  for (const m of hist) {
    const v = Number(m.value);
    if (prev !== undefined && v > prev) {
      const delta = v - prev;
      const price = store.metricAt(`price.BTC-${currency}`, m.ts + 30 * MIN);
      const p = price ? Number(price.value) : NaN;
      lines.push([
        new Date(m.ts).toISOString(), delta.toFixed(8), Number.isFinite(p) ? p.toFixed(2) : '', Number.isFinite(p) ? (delta * p).toFixed(2) : '',
        weakest(m.provenance, price?.provenance),
      ].join(';'));
    }
    prev = v;
  }
  return lines.join('\n') + '\n';
}

export const auditoria: AgentDefinition[] = [
  {
    id: 41,
    code: 'A41-AUDITOR',
    name: 'Auditor de Trilha',
    department: 9,
    responsibility: 'Mantém trilha de auditoria encadeada por hash (SHA-256) para ações, pausas e alertas, e verifica sua integridade.',
    mode: 'event',
    triggers: ['action.*', 'system.*', 'alert.raised'],
    permissions: ['write:metrics', 'emit:alert'],
    inputs: ['eventos de ação, sistema e alerta'],
    outputs: ['audit.records', 'audit.chain_ok'],
    essential: true,
    maturity: 'validado',
    async run(ctx) {
      const store = ctx.services.store;
      const cursor = store.getKV<{ ts: number; ids: string[] }>('audit.cursor', { ts: 0, ids: [] });
      const fresh = AUDITED.flatMap((t) => store.listEvents({ type: t, since: cursor.ts, limit: 1000 }))
        .filter((e) => !cursor.ids.includes(e.id))
        .sort((a, b) => a.ts - b.ts);
      let last = store.lastAudit()?.hash ?? GENESIS;
      for (const e of fresh) {
        const payload = JSON.stringify({ id: e.id, agentId: e.agentId, severity: e.severity, message: e.message, data: e.data ?? null });
        const hash = auditHash(last, e.ts, e.type, payload);
        store.insertAudit({ ts: e.ts, type: e.type, payloadJson: payload, prevHash: last, hash });
        last = hash;
      }
      const maxTs = fresh.length ? fresh[fresh.length - 1].ts : cursor.ts;
      store.setKV('audit.cursor', { ts: maxTs, ids: fresh.filter((e) => e.ts === maxTs).map((e) => e.id).concat(maxTs === cursor.ts ? cursor.ids : []) }, ctx.now());
      const v = verifyAuditChain(store);
      if (!v.ok) ctx.raiseAlert('audit.broken', 'critical', `Trilha de auditoria corrompida no registro ${v.brokenAt}`);
      return { status: 'ok', summary: `${fresh.length} registro(s) novo(s) · cadeia ${v.ok ? 'íntegra' : 'CORROMPIDA'} (${v.records})`, metrics: [metric('audit.records', v.records, 'real', 'auditoria'), metric('audit.chain_ok', v.ok, 'real', 'auditoria')] };
    },
  },
  {
    id: 42,
    code: 'A42-RECEITAS',
    name: 'Contador de Receitas',
    department: 9,
    responsibility: 'Contabiliza somente valores recebidos com confirmação on-chain no endereço monitorado.',
    mode: 'scheduled',
    intervalMs: HOUR,
    triggers: ['wallet.received'],
    permissions: ['read:metrics', 'write:metrics'],
    inputs: ['wallet.received_btc'],
    outputs: ['finance.confirmed_received_btc', 'finance.confirmed_received_local'],
    maturity: 'validado',
    async run(ctx) {
      const r = ctx.metrics.get('wallet.received_btc');
      if (!r || typeof r.value !== 'number') return { status: 'skipped', summary: 'carteira ainda não consultada' };
      const cur = ctx.config.localCurrency;
      const price = ctx.metrics.get(`price.BTC-${cur}`);
      const out = [metric('finance.confirmed_received_btc', r.value, r.provenance, r.source, 'BTC')];
      if (price && typeof price.value === 'number') out.push(metric('finance.confirmed_received_local', r.value * price.value, r.provenance === 'real' ? 'estimado' : r.provenance, 'cotação atual', cur));
      return { status: 'ok', summary: `Recebido com confirmação: ${r.value.toFixed(8)} BTC (${r.provenance})`, metrics: out };
    },
  },
  {
    id: 43,
    code: 'A43-CONCILIADOR',
    name: 'Conciliador Pool × Carteira',
    department: 9,
    responsibility: 'Compara o total pago informado pela pool com o recebido confirmado na carteira e alerta divergências.',
    mode: 'scheduled',
    intervalMs: 6 * HOUR,
    permissions: ['read:metrics', 'write:metrics', 'emit:alert'],
    inputs: ['pool.paid_total', 'finance.confirmed_received_btc'],
    outputs: ['finance.reconciliation_diff_btc'],
    maturity: 'validado',
    async run(ctx) {
      const paid = ctx.metrics.get('pool.paid_total');
      const recv = ctx.metrics.get('finance.confirmed_received_btc');
      if (!paid || !recv) return { status: 'skipped', summary: 'faltam dados da pool ou da carteira' };
      const diff = Number(paid.value) - Number(recv.value);
      const tol = Math.max(0.00001, Number(paid.value) * 0.01);
      if (diff > tol) ctx.raiseAlert('finance.reconciliation', 'warn', `Pool informa ${diff.toFixed(8)} BTC pagos a mais do que o recebido confirmado`);
      return { status: 'ok', summary: `Diferença pool − carteira: ${diff.toFixed(8)} BTC${diff > tol ? ' (divergente)' : ''}`, metrics: [metric('finance.reconciliation_diff_btc', diff, weakest(paid.provenance, recv.provenance), 'conciliação', 'BTC')] };
    },
  },
  {
    id: 44,
    code: 'A44-CARTEIRA',
    name: 'Monitor de Carteira',
    department: 9,
    responsibility: 'Consulta em modo leitura o saldo e o total recebido do endereço de recebimento (ex.: endereço de depósito da Coinbase). Não guarda chaves.',
    mode: 'scheduled',
    intervalMs: 10 * MIN,
    permissions: ['read:wallet', 'write:metrics'],
    inputs: ['WALLET_BTC_ADDRESS'],
    outputs: ['wallet.address', 'wallet.balance_btc', 'wallet.received_btc', 'wallet.unconfirmed_btc', 'wallet.tx_count'],
    maturity: 'simulado',
    async run(ctx) {
      const w = await ctx.services.wallet.info();
      const prev = ctx.memory.prevReceived as number | undefined;
      ctx.memory.prevReceived = w.receivedSat;
      const events = prev !== undefined && w.receivedSat > prev
        ? [{ type: 'wallet.received', severity: 'info' as const, message: `Recebimento confirmado de ${((w.receivedSat - prev) / 1e8).toFixed(8)} BTC`, provenance: w.provenance }]
        : [];
      return {
        status: 'ok',
        summary: `Saldo ${(w.confirmedBalanceSat / 1e8).toFixed(8)} BTC · recebido ${(w.receivedSat / 1e8).toFixed(8)} BTC · ${w.txCount} tx`,
        metrics: [
          metric('wallet.address', w.address, w.provenance, w.source),
          metric('wallet.balance_btc', w.confirmedBalanceSat / 1e8, w.provenance, w.source, 'BTC'),
          metric('wallet.received_btc', w.receivedSat / 1e8, w.provenance, w.source, 'BTC'),
          metric('wallet.unconfirmed_btc', w.unconfirmedSat / 1e8, w.provenance, w.source, 'BTC'),
          metric('wallet.tx_count', w.txCount, w.provenance, w.source),
        ],
        events,
      };
    },
  },
  {
    id: 45,
    code: 'A45-FISCAL',
    name: 'Exportador Fiscal',
    department: 9,
    responsibility: 'Gera CSV de recebimentos confirmados com a cotação do momento, para apoio à declaração. Não substitui contador.',
    mode: 'scheduled',
    intervalMs: 24 * HOUR,
    triggers: ['export.requested'],
    permissions: ['write:files', 'write:metrics'],
    inputs: ['histórico de finance.confirmed_received_btc', 'histórico de preços'],
    outputs: ['exports/recebimentos.csv'],
    maturity: 'validado',
    async run(ctx) {
      const csv = buildReceiptsCsv(ctx.services.store, ctx.config.localCurrency);
      const rows = csv.trim().split('\n').length - 1;
      if (ctx.config.dbPath !== ':memory:') {
        const dir = join(ctx.config.dataDir, 'exports');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'recebimentos.csv'), csv);
      }
      return { status: 'ok', summary: `${rows} recebimento(s) exportado(s)`, metrics: [metric('finance.receipts_exported', rows, 'real', 'exportação')] };
    },
  },
];
