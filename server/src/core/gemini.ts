// Cliente REST do Gemini (Google) para o gateway de LLM. Sem SDK e sem dependências.
//
// Fala as duas APIs de texto do Google:
//   - Interactions API  (POST /v1beta/interactions)                    : a recomendada para projetos novos;
//   - generateContent   (POST /v1beta/models/<modelo>:generateContent) : a anterior, marcada como legada.
// No modo "auto" começa pela Interactions e, se o Google recusar o FORMATO da requisição (e só nesse
// caso), tenta a outra e passa a usar a que funcionou. Erros de chave, cota ou modelo não trocam de API.
//
// A chave vai sempre no cabeçalho x-goog-api-key, nunca no endereço (endereços acabam em logs).
// Nenhuma verificação de prefixo é feita aqui: AQ.…, AIza… ou outro formato seguem como vieram.
import type { LlmCall, LlmReply, LlmTransport } from './llmGateway.ts';
import { scrubKeys } from './llmKeys.ts';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** Apelido mantido pelo Google para o Flash-Lite mais recente: o mais barato e com nível gratuito. */
export const GEMINI_DEFAULT_MODEL = 'gemini-flash-lite-latest';

export type GeminiApi = 'interactions' | 'generate-content';
export type GeminiApiMode = 'auto' | GeminiApi;
export const GEMINI_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];

/** chave: recusada · permissao: bloqueada/projeto restrito · pagamento: créditos · modelo: inexistente ·
 *  cota: limite de uso · requisicao: formato recusado · servico: erro do Google · rede: sem conexão · resposta: sem texto */
export type GeminiFailure = 'chave' | 'permissao' | 'pagamento' | 'modelo' | 'cota' | 'requisicao' | 'servico' | 'rede' | 'resposta';

export class GeminiError extends Error {
  readonly kind: GeminiFailure;
  readonly httpStatus?: number;
  /** O Google recusou o formato ou o endereço: vale tentar a outra API. */
  readonly shape: boolean;
  /** Falha passageira: vale uma nova tentativa. */
  readonly transient: boolean;
  /** Tokens consumidos mesmo sem texto útil (entram no limite mensal). */
  readonly usage?: { inputTokens: number; outputTokens: number };

  constructor(kind: GeminiFailure, message: string, opts: { httpStatus?: number; shape?: boolean; transient?: boolean; usage?: { inputTokens: number; outputTokens: number } } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.kind = kind;
    this.httpStatus = opts.httpStatus;
    this.shape = opts.shape ?? false;
    this.transient = opts.transient ?? false;
    this.usage = opts.usage;
  }
}

export interface GeminiOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  mode?: GeminiApiMode;
  /** Só é enviado quando definido; sem ele, vale o padrão do modelo. */
  thinkingLevel?: GeminiThinkingLevel;
  timeoutMs?: number;
  retryDelayMs?: number;
  /** Folga somada ao limite de saída: nos modelos do Gemini o raciocínio também consome esse limite. */
  thinkingHeadroom?: number;
  onFallback?: (to: GeminiApi, why: string) => void;
}

export interface GeminiTransport extends LlmTransport {
  /** API em uso no momento (muda só no modo auto, depois de uma troca bem-sucedida). */
  activeApi(): GeminiApi;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const count = (o: Obj, k: string): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) > 0 ? Math.round(o[k] as number) : 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Aceita "gemini-…" ou "models/gemini-…". Devolve undefined se não parecer um código de modelo. */
export function normalizeGeminiModel(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const m = String(raw).trim().replace(/^["']|["']$/g, '').replace(/^models\//i, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(m) ? m : undefined;
}

// ---------------------------------------------------------------- erros
function clean(text: string, apiKey: string): string {
  return scrubKeys(text, apiKey).replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** A Interactions API devolve erros dentro de uma lista ([{ "error": … }]); a generateContent, direto no objeto. */
function unwrap(body: unknown): unknown {
  if (!Array.isArray(body)) return body;
  return body.find((x) => isObj(x) && ('error' in x || 'steps' in x || 'outputs' in x || 'status' in x || 'candidates' in x || 'models' in x)) ?? body[0];
}

/** Converte a resposta de erro do Google (nos formatos observados nas duas APIs) em um erro com causa e orientação. */
export function geminiErrorFrom(status: number, body: unknown, ctx: { api: GeminiApi; model: string; apiKey: string }): GeminiError {
  const root = unwrap(body);
  const err = isObj(root) && isObj(root.error) ? root.error : {};
  const rawMsg = typeof err.message === 'string' ? err.message : '';
  const reasons = arr(err.details).map((d) => (isObj(d) && typeof d.reason === 'string' ? d.reason : '')).join(' ');
  const tag = `${typeof err.code === 'string' ? err.code : ''} ${typeof err.status === 'string' ? err.status : ''} ${reasons}`.toUpperCase();
  const msg = clean(rawMsg, ctx.apiKey);
  const tail = msg ? ` — Google: ${msg}` : '';
  const http = { httpStatus: status };

  if (status === 401 || /API_KEY_INVALID|UNAUTHENTICATED|\bAUTHENTICATION\b|ACCESS_TOKEN/.test(tag) || /api key not valid|api key expired|invalid authentication credentials/i.test(rawMsg)) {
    // Observado em nov/2026: chave AQ.… não reconhecida → 401 ACCESS_TOKEN_TYPE_UNSUPPORTED; demais formatos → 400 API_KEY_INVALID.
    const why = /ACCESS_TOKEN_TYPE_UNSUPPORTED/.test(tag)
      ? 'ele não reconhece esta chave de autorização; ela pode ter sido apagada, copiada pela metade ou criada há poucos minutos'
      : 'ela não existe, foi apagada, foi copiada pela metade ou é de um formato que o Google deixou de aceitar';
    return new GeminiError('chave', `o Google recusou a chave (HTTP ${status}): ${why}. Confira em https://aistudio.google.com/apikey ou crie uma nova${tail}`, http);
  }
  if (status === 402 || /PAYMENT_REQUIRED/.test(tag)) {
    return new GeminiError('pagamento', `créditos pré-pagos do projeto no Google esgotados (HTTP ${status})${tail}`, http);
  }
  if (/FAILED_PRECONDITION/.test(tag)) {
    return new GeminiError('permissao', `o Google não atende este projeto ou esta região nas condições atuais (HTTP ${status})${tail}`, http);
  }
  if (status === 403 || /PERMISSION_DENIED/.test(tag)) {
    const leaked = /leak|reported|blocked|expos/i.test(rawMsg);
    return new GeminiError('permissao', leaked
      ? `o Google bloqueou esta chave (marcada como vazada): crie outra no Google AI Studio (HTTP ${status})${tail}`
      : `sem permissão (HTTP ${status}): chave bloqueada, projeto restrito ou nível gratuito indisponível para este projeto${tail}`, http);
  }
  if (status === 404) {
    // 404 sem JSON é endereço inexistente (página HTML do Google); com JSON, é o modelo.
    if (root !== undefined && (/MODEL_NOT_FOUND/.test(tag) || /model/i.test(rawMsg) || ctx.api === 'generate-content')) {
      return new GeminiError('modelo', `o modelo "${ctx.model}" não existe ou não está disponível para esta chave: ajuste GEMINI_MODEL${tail}`, http);
    }
    return new GeminiError('requisicao', `endereço da API não encontrado (HTTP 404)${tail}`, { ...http, shape: true });
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|RATE_LIMIT|QUOTA|TOO_MANY/.test(tag)) {
    if (/limit:\s*0\b/.test(rawMsg)) {
      return new GeminiError('cota', `o modelo "${ctx.model}" não está no nível gratuito desta chave (limite 0): escolha outro em GEMINI_MODEL${tail}`, http);
    }
    const retry = /retry in ([\d.]+)\s*s/i.exec(rawMsg);
    return new GeminiError('cota', `limite de uso do Gemini atingido (HTTP ${status})${retry ? `; o Google pede nova tentativa em ${Math.ceil(Number(retry[1]))} s` : ''}${tail}`, http);
  }
  if (status >= 500) {
    return new GeminiError('servico', `serviço do Google indisponível no momento (HTTP ${status})${tail}`, { ...http, transient: true });
  }
  return new GeminiError('requisicao', `o Google recusou o formato da requisição (HTTP ${status})${tail}`, { ...http, shape: true });
}

// ---------------------------------------------------------------- HTTP
async function request(o: Required<Pick<GeminiOptions, 'timeoutMs'>> & { fetchImpl: typeof fetch }, method: 'GET' | 'POST', url: string, apiKey: string, body: unknown, ctx: { api: GeminiApi; model: string }): Promise<unknown> {
  let res: Response;
  try {
    res = await o.fetchImpl(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch (e) {
    const name = (e as Error)?.name ?? '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    throw new GeminiError('rede', timedOut
      ? `o Google não respondeu em ${Math.round(o.timeoutMs / 1000)} s`
      : 'sem conexão com o Google (generativelanguage.googleapis.com): confira a internet deste computador', { transient: !timedOut });
  }
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : {}; } catch { json = undefined; }
  if (!res.ok) throw geminiErrorFrom(res.status, json, { ...ctx, apiKey });
  if (json === undefined) throw new GeminiError('resposta', 'a resposta do Google não veio em JSON', { httpStatus: res.status });
  return json;
}

// ---------------------------------------------------------------- Interactions API
export function interactionsBody(call: LlmCall, maxOutputTokens: number, thinkingLevel?: GeminiThinkingLevel): Obj {
  const body: Obj = {
    model: call.model,
    input: call.prompt,
    generation_config: { max_output_tokens: maxOutputTokens, ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}) },
    store: false, // nada fica guardado no Google para consulta posterior
  };
  if (call.system) body.system_instruction = call.system;
  return body;
}

export function parseInteraction(raw: unknown): LlmReply {
  const d = unwrap(raw);
  if (!isObj(d)) throw new GeminiError('resposta', 'resposta do Google fora do formato esperado');
  const parts: string[] = [];
  for (const step of arr(d.steps)) {
    if (!isObj(step) || step.type !== 'model_output') continue;
    for (const c of arr(step.content)) if (isObj(c) && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
  }
  // Revisões anteriores da API devolviam "outputs" no lugar de "steps".
  if (!parts.length) for (const out of arr(d.outputs)) if (isObj(out) && out.type === 'text' && typeof out.text === 'string') parts.push(out.text);
  if (!parts.length && typeof d.output_text === 'string') parts.push(d.output_text);
  const text = parts.join('');
  const u = isObj(d.usage) ? d.usage : {};
  const usage = { inputTokens: count(u, 'total_input_tokens'), outputTokens: count(u, 'total_output_tokens') + count(u, 'total_thought_tokens') };
  const status = typeof d.status === 'string' ? d.status : '';
  if (status === 'failed' || status === 'cancelled') {
    const why = isObj(d.error) && typeof d.error.message === 'string' ? `: ${clean(d.error.message, '')}` : '';
    throw new GeminiError('resposta', `o Google encerrou a geração com o estado "${status}"${why}`, { usage });
  }
  if (!text.trim()) {
    throw new GeminiError('resposta', status === 'incomplete'
      ? 'resposta sem texto: o limite de tokens acabou antes da resposta (o modelo gastou o limite raciocinando)'
      : `resposta sem texto (estado "${status || 'não informado'}")`, { usage });
  }
  return { text, ...usage };
}

// ---------------------------------------------------------------- generateContent (legada)
export function generateContentBody(call: LlmCall, maxOutputTokens: number, thinkingLevel?: GeminiThinkingLevel): Obj {
  const body: Obj = {
    contents: [{ role: 'user', parts: [{ text: call.prompt }] }],
    generationConfig: { maxOutputTokens, ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}) },
  };
  if (call.system) body.system_instruction = { parts: [{ text: call.system }] };
  return body;
}

export function parseGenerateContent(raw: unknown): LlmReply {
  const d = unwrap(raw);
  if (!isObj(d)) throw new GeminiError('resposta', 'resposta do Google fora do formato esperado');
  const um = isObj(d.usageMetadata) ? d.usageMetadata : {};
  const usage = { inputTokens: count(um, 'promptTokenCount'), outputTokens: count(um, 'candidatesTokenCount') + count(um, 'thoughtsTokenCount') };
  const pf = isObj(d.promptFeedback) ? d.promptFeedback : {};
  if (typeof pf.blockReason === 'string') throw new GeminiError('resposta', `pedido bloqueado pelos filtros do Google (${pf.blockReason})`, { usage });
  const cand = arr(d.candidates)[0];
  const content = isObj(cand) && isObj(cand.content) ? cand.content : {};
  const text = arr(content.parts)
    .filter((p): p is Obj => isObj(p) && typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text as string)
    .join('');
  if (!text.trim()) {
    const finish = isObj(cand) && typeof cand.finishReason === 'string' ? cand.finishReason : '';
    throw new GeminiError('resposta', finish === 'MAX_TOKENS'
      ? 'resposta sem texto: o limite de tokens acabou antes da resposta (o modelo gastou o limite raciocinando)'
      : `resposta sem texto (${finish || 'nenhum candidato'})`, { usage });
  }
  return { text, ...usage };
}

// ---------------------------------------------------------------- transporte para o gateway
export function createGeminiTransport(opts: GeminiOptions = {}): GeminiTransport {
  const o = {
    fetchImpl: opts.fetchImpl ?? fetch,
    baseUrl: (opts.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, ''),
    mode: opts.mode ?? 'auto',
    timeoutMs: opts.timeoutMs ?? 20_000,
    retryDelayMs: opts.retryDelayMs ?? 800,
    headroom: opts.thinkingHeadroom ?? 1024,
  };
  let active: GeminiApi = o.mode === 'generate-content' ? 'generate-content' : 'interactions';

  const once = async (api: GeminiApi, call: LlmCall, apiKey: string): Promise<LlmReply> => {
    const max = Math.max(1, Math.round(call.maxTokens)) + o.headroom;
    if (api === 'interactions') {
      return parseInteraction(await request(o, 'POST', `${o.baseUrl}/interactions`, apiKey, interactionsBody(call, max, opts.thinkingLevel), { api, model: call.model }));
    }
    const url = `${o.baseUrl}/models/${encodeURIComponent(call.model)}:generateContent`;
    return parseGenerateContent(await request(o, 'POST', url, apiKey, generateContentBody(call, max, opts.thinkingLevel), { api, model: call.model }));
  };
  const run = async (api: GeminiApi, call: LlmCall, apiKey: string): Promise<LlmReply> => {
    try {
      return await once(api, call, apiKey);
    } catch (e) {
      if (!(e instanceof GeminiError) || !e.transient) throw e;
      await sleep(o.retryDelayMs); // uma única nova tentativa em falha passageira
      return await once(api, call, apiKey);
    }
  };

  const transport = async (call: LlmCall, apiKey: string): Promise<LlmReply> => {
    const model = normalizeGeminiModel(call.model);
    if (!model) throw new GeminiError('modelo', `nome de modelo inválido: ajuste GEMINI_MODEL (exemplo: ${GEMINI_DEFAULT_MODEL})`);
    const c = { ...call, model };
    try {
      return await run(active, c, apiKey);
    } catch (e) {
      if (o.mode !== 'auto' || !(e instanceof GeminiError) || !e.shape) throw e;
      const other: GeminiApi = active === 'interactions' ? 'generate-content' : 'interactions';
      let reply: LlmReply;
      try {
        reply = await run(other, c, apiKey);
      } catch {
        throw e; // a outra API também falhou: vale o primeiro erro
      }
      active = other;
      opts.onFallback?.(other, e.message);
      return reply;
    }
  };
  return Object.assign(transport, { activeApi: () => active });
}

// ---------------------------------------------------------------- verificação da chave (ferramentas e painel)
export interface GeminiCheck {
  ok: boolean;
  model: string;
  api?: GeminiApi;
  kind?: GeminiFailure;
  httpStatus?: number;
  message: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Modelos de texto que a chave enxerga (quando o Google informa). */
  models?: string[];
}

/** Lista os modelos de texto visíveis para a chave. Melhor esforço: qualquer falha devolve lista vazia. */
export async function listGeminiModels(apiKey: string, opts: GeminiOptions = {}): Promise<string[]> {
  const o = { fetchImpl: opts.fetchImpl ?? fetch, timeoutMs: opts.timeoutMs ?? 20_000 };
  const base = (opts.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, '');
  try {
    const d = await request(o, 'GET', `${base}/models?pageSize=200`, apiKey, undefined, { api: 'generate-content', model: '' });
    const root = unwrap(d);
    const names = arr(isObj(root) ? root.models : undefined)
      .filter((m): m is Obj => isObj(m) && typeof m.name === 'string')
      .filter((m) => !Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => normalizeGeminiModel(m.name as string))
      .filter((n): n is string => !!n && /^gemini-/.test(n) && !/image|tts|live|audio|embedding|robotics|computer-use|transcribe/.test(n));
    const rank = (n: string) => (/flash-lite/.test(n) ? 0 : /flash/.test(n) ? 1 : 2);
    return [...new Set(names)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 20);
  } catch {
    return [];
  }
}

/**
 * Teste real da chave: uma geração mínima no modelo escolhido. É a única validação que vale,
 * porque o formato da chave não diz se o Google a aceita. Consome poucos tokens.
 */
export async function checkGeminiKey(apiKey: string, model: string, opts: GeminiOptions = {}): Promise<GeminiCheck> {
  const transport = createGeminiTransport(opts);
  try {
    const r = await transport({ model, system: 'Responda somente com a palavra OK.', prompt: 'Teste de conexão.', maxTokens: 16 }, apiKey);
    return { ok: true, model, api: transport.activeApi(), message: `o Google aceitou a chave e o modelo ${model} respondeu`, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  } catch (e) {
    const ge = e instanceof GeminiError ? e : new GeminiError('rede', clean(String((e as Error)?.message ?? e), apiKey));
    // Sem texto, mas com resposta do Google: a chave e o modelo foram aceitos.
    if (ge.kind === 'resposta') {
      return { ok: true, model, api: transport.activeApi(), message: `o Google aceitou a chave; o modelo ${model} respondeu sem texto neste teste (${ge.message})`, ...ge.usage };
    }
    const models = ge.kind === 'modelo' || ge.kind === 'cota' ? await listGeminiModels(apiKey, opts) : undefined;
    return { ok: false, model, kind: ge.kind, httpStatus: ge.httpStatus, message: ge.message, models: models?.length ? models : undefined };
  }
}
