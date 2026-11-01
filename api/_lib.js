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

// ---------------- endereço da Pearl
// A Pearl usa endereços bech32m com prefixo "prl" (ex.: o explorador oficial explorer.pearlresearch.ai mostra
// endereços "prl1p…" de 63 caracteres). O dígito verificador pega erros de digitação antes de consultar a pool.
const BECH32_CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const v of values) {
    const b = c >>> 25;
    c = ((c & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= G[i];
  }
  return c >>> 0;
}

/** Devolve null se o endereço da Pearl é válido, ou o motivo (em português) se não for. */
export function pearlAddressIssue(raw) {
  const a = String(raw ?? '').trim();
  if (!a) return 'cole o endereço da sua carteira Pearl (começa com prl1…)';
  if (/\s/.test(a)) return 'o texto tem espaços. Endereço não tem espaços. Se for uma frase-semente, não cole aqui nem em lugar nenhum';
  if (a !== a.toLowerCase() && a !== a.toUpperCase()) return 'o endereço mistura letras maiúsculas e minúsculas: copie de novo da carteira';
  const s = a.toLowerCase();
  if (!s.startsWith('prl1')) return `endereços da Pearl começam com "prl1"; este começa com "${s.slice(0, 4).replace(/[^a-z0-9]/g, '?')}"`;
  if (s.length < 14 || s.length > 90) return `tamanho inesperado (${s.length} caracteres)`;
  const bad = [...new Set([...s.slice(4)].filter((c) => !BECH32_CHARS.includes(c)))];
  if (bad.length) return `tem caracteres que não existem em endereço Pearl (${bad.slice(0, 5).map((c) => `"${c}"`).join(', ')})`;
  const hrp = 'prl';
  const values = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...[...s.slice(4)].map((c) => BECH32_CHARS.indexOf(c))];
  const pm = polymod(values);
  if (pm !== 0x2bc830a3 && pm !== 1) return 'o dígito verificador não confere: provavelmente há um erro de digitação. Copie o endereço de novo da carteira';
  return null;
}

export function queryParam(req, name) {
  try {
    return new URL(req.url, 'http://local').searchParams.get(name);
  } catch {
    return null;
  }
}
