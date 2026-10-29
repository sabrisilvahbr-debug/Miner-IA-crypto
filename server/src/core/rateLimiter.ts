// Limitador de chamadas externas (balde de fichas por host) e cliente HTTP com tempo limite.

export class RateLimitedError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`limite de chamadas externas atingido para ${host}`);
    this.host = host;
  }
}

export class DisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisconnectedError';
  }
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  allowed: number;
  throttled: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private perMinute: number;
  private now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.perMinute = Math.max(1, perMinute);
    this.now = now;
  }

  tryTake(host: string): boolean {
    const t = this.now();
    const b = this.buckets.get(host) ?? { tokens: this.perMinute, updatedAt: t, allowed: 0, throttled: 0 };
    b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.updatedAt) / 60000) * this.perMinute);
    b.updatedAt = t;
    this.buckets.set(host, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      b.allowed++;
      return true;
    }
    b.throttled++;
    return false;
  }

  stats(): { host: string; allowed: number; throttled: number; tokens: number }[] {
    return [...this.buckets.entries()].map(([host, b]) => ({
      host,
      allowed: b.allowed,
      throttled: b.throttled,
      tokens: Math.floor(b.tokens),
    }));
  }
}

export interface HttpClient {
  getJson<T = unknown>(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<T>;
  postJson<T = unknown>(url: string, body: unknown, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<T>;
}

export function createHttpClient(limiter: RateLimiter, fetchImpl: typeof fetch = fetch): HttpClient {
  async function request<T>(method: string, url: string, body: unknown, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
    const host = new URL(url).host;
    if (!limiter.tryTake(host)) throw new RateLimitedError(host);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
    } catch (e) {
      throw new DisconnectedError(`sem resposta de ${host}: ${(e as Error).message}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${host}`);
    return (await res.json()) as T;
  }
  return {
    getJson: (url, opts) => request('GET', url, undefined, opts),
    postJson: (url, body, opts) => request('POST', url, body, opts),
  };
}
