// Cliente da API com token opcional (guardado neste navegador) e canal em tempo real (SSE).

const TOKEN_KEY = 'office50.token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

export function setToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* armazenamento indisponível */ }
}

export class UnauthorizedError extends Error {}

export async function api(path, opts = {}) {
  const token = getToken();
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) throw new UnauthorizedError('não autorizado');
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok && !opts.allowError) throw Object.assign(new Error(data?.error ?? data?.reason ?? `HTTP ${res.status}`), { data, status: res.status });
  return data;
}

export function connectStream(handlers) {
  const token = getToken();
  const es = new EventSource(`/api/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  es.addEventListener('state', (e) => handlers.state?.(JSON.parse(e.data)));
  es.addEventListener('event', (e) => handlers.event?.(JSON.parse(e.data)));
  es.onopen = () => handlers.open?.();
  es.onerror = () => handlers.error?.();
  return es;
}
