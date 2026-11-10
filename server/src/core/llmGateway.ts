// Gateway único de LLM. Desligado por padrão. Dois provedores: Gemini (Google) e Claude (Anthropic).
// Limites de chamadas por dia e tokens por mês, tempo limite, validação da saída e fallback determinístico.
// A chave nunca sai do backend: não entra em logs, eventos, métricas nem nas respostas da API.
import type { Store } from './store.ts';
import type { AppConfig } from '../config.ts';
import { createGeminiTransport, GeminiError, type GeminiApi, type GeminiTransport } from './gemini.ts';
import { scrubKeys, type GoogleKeyKind } from './llmKeys.ts';

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

/** Pedido já normalizado, igual para qualquer provedor. */
export interface LlmCall {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface LlmReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export type LlmTransport = (call: LlmCall, apiKey: string) => Promise<LlmReply>;

export type LlmProviderName = 'anthropic' | 'gemini';

export const anthropicTransport: LlmTransport = async (call, apiKey) => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: call.model, max_tokens: call.maxTokens, system: call.system, messages: [{ role: 'user', content: call.prompt }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Claude API HTTP ${res.status}`);
  const d = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  const text = (d.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  return { text, inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0 };
};

export interface LlmProviderChoice {
  provider?: LlmProviderName;
  apiKey?: string;
  model?: string;
  keyKind?: GoogleKeyKind;
  /** Por que não há provedor utilizável (quando apiKey está ausente). Nunca contém a chave. */
  reason?: string;
  /** Observações que não impedem o uso. Nunca contêm a chave. */
  notes: string[];
}

const looksGoogle = (k: string | undefined): boolean => !!k && /^(AQ\.|AIza)/.test(k);

/**
 * Escolhe o provedor a partir da configuração.
 * LLM_PROVIDER=auto: usa o provedor da única chave presente; com as duas, mantém a Anthropic
 * (comportamento anterior) e avisa. Uma chave do Google colocada em ANTHROPIC_API_KEY é usada como
 * chave do Gemini, com aviso, em vez de falhar na Anthropic.
 */
export function resolveLlmProvider(c: AppConfig): LlmProviderChoice {
  const notes: string[] = [];
  let anthropicKey = c.anthropicApiKey;
  let geminiKey = c.geminiApiKey;
  let geminiKind = c.geminiKeyKind;
  if (looksGoogle(anthropicKey) && !geminiKey && !c.geminiKeyProblem) {
    if (c.llmProvider === 'anthropic') {
      notes.push('ANTHROPIC_API_KEY contém uma chave do Google, mas LLM_PROVIDER=anthropic: mova-a para GEMINI_API_KEY e use LLM_PROVIDER=gemini (ou auto)');
    } else {
      geminiKey = anthropicKey;
      geminiKind = anthropicKey!.startsWith('AQ.') ? 'autorizacao' : 'padrao';
      anthropicKey = undefined;
      notes.push('a chave em ANTHROPIC_API_KEY é do Google e foi usada como chave do Gemini: mova-a para GEMINI_API_KEY');
    }
  }
  let provider: LlmProviderName | undefined;
  if (c.llmProvider === 'gemini' || c.llmProvider === 'anthropic') provider = c.llmProvider;
  else if (geminiKey && !anthropicKey) provider = 'gemini';
  else if (anthropicKey) {
    provider = 'anthropic';
    if (geminiKey) notes.push('há chave do Gemini e da Anthropic: em uso a da Anthropic; defina LLM_PROVIDER=gemini para usar o Gemini');
  } else if (c.geminiKeyProblem) provider = 'gemini';

  if (!provider) return { reason: 'nenhuma chave de LLM configurada: defina GEMINI_API_KEY (Google AI Studio) ou ANTHROPIC_API_KEY', notes };
  if (provider === 'gemini') {
    if (c.geminiModelProblem) notes.push(c.geminiModelProblem);
    if (!geminiKey) {
      const reason = c.geminiKeyProblem ? `${c.geminiKeySource ?? 'GEMINI_API_KEY'} não pôde ser usada: ${c.geminiKeyProblem}` : 'GEMINI_API_KEY ausente';
      return { provider, model: c.geminiModel, reason, notes };
    }
    if (c.geminiKeyWarning && geminiKey === c.geminiApiKey) notes.push(c.geminiKeyWarning);
    return { provider, apiKey: geminiKey, model: c.geminiModel, keyKind: geminiKind, notes };
  }
  if (!anthropicKey) return { provider, model: c.llmModel, reason: 'ANTHROPIC_API_KEY ausente', notes };
  return { provider, apiKey: anthropicKey, model: c.llmModel, notes };
}

export interface LlmStatus {
  enabled: boolean;
  reason?: string;
  provider?: LlmProviderName;
  model?: string;
  /** Formato da chave do Google em uso (a chave em si nunca é exposta). */
  keyKind?: GoogleKeyKind;
  /** API do Gemini em uso (interactions ou generate-content). */
  api?: GeminiApi;
  notes: string[];
  /** Resultado da última chamada desde que o programa iniciou. */
  last?: { ok: boolean; at: number; reason?: string; kind?: string };
  callsToday: number;
  tokensThisMonth: number;
  maxCallsPerDay: number;
  maxTokensPerMonth: number;
}

export interface LlmValidation {
  ok: boolean;
  at: number;
  provider?: LlmProviderName;
  model?: string;
  api?: GeminiApi;
  detail: string;
}

export class LlmGateway {
  private store: Store;
  private config: AppConfig;
  private now: () => number;
  private transport: LlmTransport;
  private gemini?: GeminiTransport;
  private choice: LlmProviderChoice;
  private last?: LlmStatus['last'];

  constructor(store: Store, config: AppConfig, now: () => number = Date.now, transport?: LlmTransport, fetchImpl?: typeof fetch) {
    this.store = store;
    this.config = config;
    this.now = now;
    this.choice = resolveLlmProvider(config);
    if (transport) this.transport = transport;
    else if (this.choice.provider === 'gemini') {
      this.gemini = createGeminiTransport({ fetchImpl, mode: config.geminiApiMode, thinkingLevel: config.geminiThinkingLevel });
      this.transport = this.gemini;
    } else this.transport = anthropicTransport;
  }

  status(): LlmStatus {
    const d = new Date(this.now());
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const today = this.store.llmUsageSince(dayStart);
    const month = this.store.llmUsageSince(monthStart);
    const p = this.choice;
    let reason: string | undefined;
    if (!this.config.llmEnabled) reason = 'LLM desativado (LLM_ENABLED=false)';
    else if (!p.apiKey) reason = p.reason ?? 'chave de LLM ausente';
    else if (today.calls >= this.config.llmMaxCallsPerDay) reason = 'limite diário de chamadas atingido';
    else if (month.tokens >= this.config.llmMaxTokensPerMonth) reason = 'limite mensal de tokens atingido';
    return {
      enabled: !reason,
      reason,
      provider: p.provider,
      model: p.model,
      keyKind: p.keyKind,
      api: this.gemini?.activeApi(),
      notes: [...p.notes],
      last: this.last ? { ...this.last } : undefined,
      callsToday: today.calls,
      tokensThisMonth: month.tokens,
      maxCallsPerDay: this.config.llmMaxCallsPerDay,
      maxTokensPerMonth: this.config.llmMaxTokensPerMonth,
    };
  }

  async complete(req: LlmRequest): Promise<LlmOutcome> {
    const st = this.status();
    if (!st.enabled) return { ok: false, reason: st.reason ?? 'indisponível' };
    const apiKey = this.choice.apiKey!;
    try {
      const r = await this.transport(
        { model: this.choice.model!, system: req.system, prompt: req.prompt, maxTokens: Math.min(req.maxTokens ?? 600, 1500) },
        apiKey,
      );
      this.store.insertLlmUsage({ ts: this.now(), agentId: req.agentId, purpose: req.purpose, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ok: true });
      this.last = { ok: true, at: this.now() };
      return { ok: true, ...r };
    } catch (e) {
      // Nenhuma mensagem de erro guardada ou devolvida pode conter a chave.
      const message = scrubKeys(String((e as Error)?.message ?? e), apiKey).slice(0, 400);
      const usage = e instanceof GeminiError ? e.usage : undefined;
      this.store.insertLlmUsage({ ts: this.now(), agentId: req.agentId, purpose: req.purpose, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, ok: false, error: message });
      this.last = { ok: false, at: this.now(), reason: message, kind: e instanceof GeminiError ? e.kind : 'erro' };
      return { ok: false, reason: `falha na chamada: ${message}` };
    }
  }

  /** Chamada mínima para conferir chave e modelo. Passa pelos mesmos limites e fica registrada no uso. */
  async validate(): Promise<LlmValidation> {
    const r = await this.complete({ agentId: 33, purpose: 'validacao', system: 'Responda somente com a palavra OK.', prompt: 'Teste de conexão.', maxTokens: 16 });
    const base = { at: this.now(), provider: this.choice.provider, model: this.choice.model, api: this.gemini?.activeApi() };
    return r.ok
      ? { ok: true, ...base, detail: `${this.choice.provider === 'gemini' ? 'o Google' : 'a Anthropic'} aceitou a chave e o modelo ${this.choice.model} respondeu` }
      : { ok: false, ...base, detail: r.reason };
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
