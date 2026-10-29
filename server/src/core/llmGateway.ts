// Gateway único de LLM (Claude API). Desligado por padrão.
// Limites de chamadas por dia e tokens por mês, tempo limite, validação da saída e fallback determinístico.
import type { Store } from './store.ts';
import type { AppConfig } from '../config.ts';

export interface LlmRequest {
  agentId: number;
  purpose: string;
  system: string;
  prompt: string;
  maxTokens?: number;
}

export type LlmOutcome =
  | { ok: true; text: string; inputTokens: number; outputTokens: number }
  | { ok: false; reason: string };

export type LlmTransport = (body: Record<string, unknown>, apiKey: string) => Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
}>;

export const anthropicTransport: LlmTransport = async (body, apiKey) => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Claude API HTTP ${res.status}`);
  const d = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  const text = (d.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  return { text, inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0 };
};

export class LlmGateway {
  private store: Store;
  private config: AppConfig;
  private now: () => number;
  private transport: LlmTransport;

  constructor(store: Store, config: AppConfig, now: () => number = Date.now, transport: LlmTransport = anthropicTransport) {
    this.store = store;
    this.config = config;
    this.now = now;
    this.transport = transport;
  }

  status(): { enabled: boolean; reason?: string; callsToday: number; tokensThisMonth: number; maxCallsPerDay: number; maxTokensPerMonth: number } {
    const d = new Date(this.now());
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const today = this.store.llmUsageSince(dayStart);
    const month = this.store.llmUsageSince(monthStart);
    let reason: string | undefined;
    if (!this.config.llmEnabled) reason = 'LLM desativado (LLM_ENABLED=false)';
    else if (!this.config.anthropicApiKey) reason = 'ANTHROPIC_API_KEY ausente';
    else if (today.calls >= this.config.llmMaxCallsPerDay) reason = 'limite diário de chamadas atingido';
    else if (month.tokens >= this.config.llmMaxTokensPerMonth) reason = 'limite mensal de tokens atingido';
    return {
      enabled: !reason,
      reason,
      callsToday: today.calls,
      tokensThisMonth: month.tokens,
      maxCallsPerDay: this.config.llmMaxCallsPerDay,
      maxTokensPerMonth: this.config.llmMaxTokensPerMonth,
    };
  }

  async complete(req: LlmRequest): Promise<LlmOutcome> {
    const st = this.status();
    if (!st.enabled) return { ok: false, reason: st.reason ?? 'indisponível' };
    try {
      const r = await this.transport(
        {
          model: this.config.llmModel,
          max_tokens: Math.min(req.maxTokens ?? 600, 1500),
          system: req.system,
          messages: [{ role: 'user', content: req.prompt }],
        },
        this.config.anthropicApiKey!,
      );
      this.store.insertLlmUsage({ ts: this.now(), agentId: req.agentId, purpose: req.purpose, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ok: true });
      return { ok: true, ...r };
    } catch (e) {
      this.store.insertLlmUsage({ ts: this.now(), agentId: req.agentId, purpose: req.purpose, inputTokens: 0, outputTokens: 0, ok: false, error: String(e) });
      return { ok: false, reason: `falha na chamada: ${(e as Error).message}` };
    }
  }
}

/** Valida a análise gerada: JSON com campos esperados, sem promessas de lucro e sem números inventados. */
export function validateAnalysis(text: string, allowedNumbers: number[]): { ok: true; value: { resumo: string; riscos: string[] } } | { ok: false; reason: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, reason: 'resposta sem JSON' };
  let v: unknown;
  try {
    v = JSON.parse(m[0]);
  } catch {
    return { ok: false, reason: 'JSON inválido' };
  }
  const o = v as { resumo?: unknown; riscos?: unknown };
  if (typeof o.resumo !== 'string' || !Array.isArray(o.riscos) || !o.riscos.every((r) => typeof r === 'string')) {
    return { ok: false, reason: 'campos resumo/riscos ausentes' };
  }
  const all = `${o.resumo} ${(o.riscos as string[]).join(' ')}`;
  if (o.resumo.length > 1200) return { ok: false, reason: 'resumo longo demais' };
  if (/(lucro garantido|garantid[oa]|sem risco|retorno certo|renda passiva garantida)/i.test(all)) {
    return { ok: false, reason: 'contém promessa de rentabilidade' };
  }
  // Todo número com 3+ dígitos significativos precisa existir nos dados fornecidos (tolerância de 1%).
  for (const tok of all.match(/\d[\d.,]{2,}/g) ?? []) {
    const val = Number(tok.replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(val) || val < 100) continue;
    const known = allowedNumbers.some((a) => a !== 0 && Math.abs(a - val) / Math.abs(a) < 0.01);
    if (!known) return { ok: false, reason: `número não presente nos dados: ${tok}` };
  }
  return { ok: true, value: { resumo: o.resumo, riscos: o.riscos as string[] } };
}
