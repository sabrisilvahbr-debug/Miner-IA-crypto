// GET /api/carteira?endereco=SEU_ENDERECO_PRL — saldo, pagamentos e workers na pool Kryptex (somente leitura).
// Rotas da API pública documentada em https://pool.kryptex.com/openapi.yaml:
//   /prl/api/v1/miner/balance/{address}        → total, threshold, reached_pct, unconfirmed, confirmed
//   /prl/api/v1/miner/payouts/{address}/stats  → paid, unpaid, reward.week, reward.month
//   /prl/api/v1/miner/payouts/{address}        → count, results[date, received, txid, status]
//   /prl/api/v3/miner/workers/{address}        → count, results[worker, scheme, hashrate, shares, last_share]
// A especificação não informa as unidades: o painel mostra isso. Pagamento "informado pela pool" não é
// pagamento confirmado na blockchain.
import { attempt, getJson, isNum, numLike, pearlAddressIssue, queryParam, send } from './_lib.js';

const BASE = 'https://pool.kryptex.com/prl';

const num = (v) => numLike(v) ?? null;

export async function saldo(addr, fetchImpl) {
  const d = await getJson(`${BASE}/api/v1/miner/balance/${addr}`, { fetchImpl });
  if (!d || typeof d !== 'object') throw new Error('resposta fora do formato');
  return { total: num(d.total), confirmado: num(d.confirmed), naoConfirmado: num(d.unconfirmed), limitePagamento: num(d.threshold), atingidoPct: num(d.reached_pct) };
}

export async function resumoPagamentos(addr, fetchImpl) {
  const d = await getJson(`${BASE}/api/v1/miner/payouts/${addr}/stats`, { fetchImpl });
  if (!d || typeof d !== 'object') throw new Error('resposta fora do formato');
  return { pago: num(d.paid), aReceber: num(d.unpaid), recompensaSemana: num(d.reward && d.reward.week), recompensaMes: num(d.reward && d.reward.month) };
}

export async function pagamentos(addr, fetchImpl) {
  const d = await getJson(`${BASE}/api/v1/miner/payouts/${addr}?page=1`, { fetchImpl });
  const results = Array.isArray(d && d.results) ? d.results : [];
  return {
    quantidade: isNum(d && d.count) ? d.count : results.length,
    ultimos: results.slice(0, 5).map((p) => ({
      data: isNum(p.date) ? p.date : null,
      valor: num(p.received),
      txid: typeof p.txid === 'string' && /^[A-Za-z0-9]{8,128}$/.test(p.txid) ? p.txid : null,
      statusNaPool: typeof p.status === 'string' ? p.status.slice(0, 30) : null,
    })),
  };
}

export async function workers(addr, fetchImpl) {
  const d = await getJson(`${BASE}/api/v3/miner/workers/${addr}`, { fetchImpl });
  const results = Array.isArray(d && d.results) ? d.results : [];
  return {
    quantidade: isNum(d && d.count) ? d.count : results.length,
    lista: results.slice(0, 20).map((w) => ({
      nome: typeof w.worker === 'string' ? w.worker.slice(0, 40) : '?',
      hashrate: num(w.hashrate),
      shares: num(w.shares),
      ultimaShare: isNum(w.last_share) ? w.last_share : null,
    })),
  };
}

export default async function handler(req, res, fetchImpl = globalThis.fetch) {
  if (req.method && req.method !== 'GET') return send(res, 405, { error: 'somente leitura (GET)' });
  const raw = queryParam(req, 'endereco') || '';
  const issue = pearlAddressIssue(raw);
  if (issue) return send(res, 400, { error: `Endereço inválido: ${issue}.` });
  const addr = raw.trim().toLowerCase();
  const sem = (x) => (x.ok || !/HTTP 404/.test(x.motivo) ? x : { ok: false, motivo: 'a Kryptex não tem registro deste endereço' });
  const [s, r, p, w] = (await Promise.all([
    attempt('saldo', () => saldo(addr, fetchImpl)),
    attempt('resumo de pagamentos', () => resumoPagamentos(addr, fetchImpl)),
    attempt('pagamentos', () => pagamentos(addr, fetchImpl)),
    attempt('workers', () => workers(addr, fetchImpl)),
  ])).map(sem);
  send(res, 200, {
    moeda: 'PRL', pool: 'Kryptex', fonte: 'https://pool.kryptex.com/openapi.yaml', consultadoEm: new Date().toISOString(),
    unidades: 'a API da Kryptex não documenta as unidades; confira na página da pool',
    saldo: s, resumoPagamentos: r, pagamentos: p, workers: w,
    aviso: 'pagamentos informados pela pool não foram conferidos na blockchain',
  }, 60);
}
