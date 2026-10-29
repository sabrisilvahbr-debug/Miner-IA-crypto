// Logs estruturados em JSON Lines, com mascaramento de segredos.
import type { Severity } from './types.ts';

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|private)/i;
const LEVELS: Record<Severity, number> = { debug: 10, info: 20, warn: 30, error: 40, critical: 50 };

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) && v !== undefined && v !== null && v !== '' ? '***' : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  log(severity: Severity, message: string, data?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => process.stdout.write(l + '\n'),
  minLevel: Severity = (process.env.LOG_LEVEL as Severity) ?? 'info',
): Logger {
  const min = LEVELS[minLevel] ?? 20;
  return {
    log(severity, message, data) {
      if (LEVELS[severity] < min) return;
      sink(JSON.stringify({ ts: new Date().toISOString(), level: severity, msg: message, ...base, ...(redact(data ?? {}) as object) }));
    },
    child(fields) {
      return createLogger({ ...base, ...fields }, sink, minLevel);
    },
  };
}

export const silentLogger: Logger = { log() {}, child() { return silentLogger; } };
