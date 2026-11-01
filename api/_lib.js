// Utilitários das funções da Vercel (arquivos com "_" não viram rota).
// Só leitura: cada função consulta endereços FIXOS de fontes públicas; nada vindo do navegador vira URL livre.

export async function getJson(url, { timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json', 'user-agent': 'office50-painel-online (somente leitura)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`sem resposta em ${timeoutMs / 1000} s`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** Executa uma consulta e nunca derruba a resposta inteira: falha vira { ok: false, motivo }. */
export async function attempt(label, fn) {
  try {
    return { ok: true, ...(await fn()) };
  } catch (e) {
    return { ok: false, motivo: `${label}: ${e && e.message ? e.message : 'falha'}` };
  }
}

export function send(res, status, body, cacheSeconds = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', cacheSeconds ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 5}` : 'no-store');
  res.end(JSON.stringify(body));
}

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const numLike = (v) => (isNum(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Endereço público de carteira: só letras e números (o mesmo filtro do painel do computador). */
export const ADDRESS_RE = /^[A-Za-z0-9]{20,128}$/;

export function queryParam(req, name) {
  try {
    return new URL(req.url, 'http://local').searchParams.get(name);
  } catch {
    return null;
  }
}
