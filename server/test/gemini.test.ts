// Gateway do Gemini: chaves em qualquer formato do Google, as duas APIs de texto, erros e limites.
// Nenhum teste fala com a rede: as respostas do Google são reproduzidas a partir da documentação
// (sucesso) e de respostas reais observadas em 10/11/2026 com chaves falsas (erros).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { makeApp } from './helpers.ts';
import { geminiConfig, parseDotEnv, testConfig } from '../src/config.ts';
import { describeKeyKind, inspectGoogleKey, maskKey, normalizeApiKey, scrubKeys } from '../src/core/llmKeys.ts';
import {
  GEMINI_DEFAULT_MODEL, GeminiError, checkGeminiKey, createGeminiTransport, listGeminiModels, normalizeGeminiModel,
  parseGenerateContent, parseInteraction,
} from '../src/core/gemini.ts';
import { resolveLlmProvider } from '../src/core/llmGateway.ts';
import { createApiServer } from '../src/api/server.ts';
import { applyGeminiEnv } from '../src/tools/gemini-setup.ts';
import { describeCheck } from '../src/tools/gemini-check.ts';

// Chaves FALSAS, montadas em tempo de execução para que nenhum texto com cara de chave fique no repositório.
const AQ_KEY = ['AQ', `Ab8RN6${'x'.repeat(20)}-${'Y'.repeat(18)}_z9`].join('.'); // formato atual (autorização)
const OLD_KEY = `${'AI'}${'za'}Sy${'B'.repeat(33)}`; // formato antigo (padrão), 39 caracteres
const ODD_KEY = `gk-${'q7'.repeat(20)}`; // formato que o Google ainda não inventou

// ---------------------------------------------------------------- respostas do Google
/** Exemplo de sucesso da referência da Interactions API. */
const INTERACTION_OK = {
  created: '2025-11-26T12:25:15Z', id: 'v1_abc', model: 'gemini-3.6-flash', object: 'interaction', status: 'completed',
  steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"resumo":"Sem pontos de atenção.","riscos":[]}' }] }],
  updated: '2025-11-26T12:25:15Z',
  usage: { input_tokens_by_modality: [{ modality: 'text', tokens: 7 }], total_cached_tokens: 0, total_input_tokens: 7, total_output_tokens: 20, total_thought_tokens: 22, total_tokens: 49, total_tool_use_tokens: 0 },
};
const GENERATE_OK = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'pensando…', thought: true }, { text: '{"resumo":"Tudo certo.","riscos":[]}' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 12, thoughtsTokenCount: 30, totalTokenCount: 51 },
  modelVersion: 'gemini-3.5-flash-lite',
};
/** Real: chave AQ.… que o Google não reconhece, na Interactions API (o erro vem dentro de uma lista). */
const ERR_AQ_UNKNOWN = [{ error: { code: 401, message: 'API key not valid. Please pass a valid API key.', status: 'UNAUTHENTICATED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_TYPE_UNSUPPORTED', metadata: { method: 'google.learning.gemini.api.interactions.v1beta.InteractionsService.CreateInteractionHttp', service: 'generativelanguage.googleapis.com' } }] } }];
/** Real: chave em outro formato que o Google não reconhece. */
const ERR_KEY_INVALID = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } }, { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'en-US', message: 'API key not valid. Please pass a valid API key.' }] } };
const ERR_QUOTA = { error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash-lite\nPlease retry in 46.457504798s.', status: 'RESOURCE_EXHAUSTED' } };
const ERR_NOT_FREE = { error: { code: 429, message: 'You exceeded your current quota. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-4-argon', status: 'RESOURCE_EXHAUSTED' } };
const ERR_SHAPE = [{ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "store": Cannot find field.', status: 'INVALID_ARGUMENT' } }];

interface Call { url: string; method: string; headers: Record<string, string>; body: any }
type Reply = { status?: number; json?: unknown; text?: string; contentType?: string } | Error;

/** fetch de mentira: registra cada chamada e responde o que o teste mandar. */
function fakeFetch(handler: (c: Call, n: number) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = await handler(call, calls.length);
    if (r instanceof Error) throw r;
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': r.contentType ?? 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

const CALL = { model: 'gemini-flash-lite-latest', system: 'Responda só com JSON.', prompt: 'Dados atuais.', maxTokens: 500 };
const fast = { retryDelayMs: 1 };

async function failure(p: Promise<unknown>): Promise<GeminiError> {
  try { await p; } catch (e) { assert.ok(e instanceof GeminiError, `esperava GeminiError, veio ${String(e)}`); return e; }
  assert.fail('a chamada deveria ter falhado');
}

// ================================================================ chaves
test('chave: aceita o formato atual (AQ.…), o antigo (AIza…) e formatos desconhecidos', () => {
  const aq = inspectGoogleKey(AQ_KEY);
  assert.deepEqual({ ok: aq.ok, key: aq.key, kind: aq.kind, warning: aq.warning }, { ok: true, key: AQ_KEY, kind: 'autorizacao', warning: undefined });
  const old = inspectGoogleKey(OLD_KEY);
  assert.equal(old.ok, true);
  assert.equal(old.key, OLD_KEY);
  assert.equal(old.kind, 'padrao');
  assert.match(old.warning!, /formato antigo/);
  const odd = inspectGoogleKey(ODD_KEY);
  assert.equal(odd.ok, true, 'o formato não decide: quem decide é o Google');
  assert.equal(odd.key, ODD_KEY);
  assert.equal(odd.kind, 'desconhecido');
  assert.match(odd.warning!, /enviada ao Google assim mesmo/);
  // AIza com tamanho diferente do antigo também segue, com aviso
  assert.equal(inspectGoogleKey(`${OLD_KEY}extra`).ok, true);
  assert.match(describeKeyKind('autorizacao'), /AQ/);
});

test('chave: limpa o que costuma vir junto ao copiar', () => {
  for (const pasted of [
    `  ${AQ_KEY}  `, `"${AQ_KEY}"`, `'${AQ_KEY}'`, `“${AQ_KEY}”`, `${AQ_KEY}\r\n`, `﻿${AQ_KEY}​`,
    `GEMINI_API_KEY=${AQ_KEY}`, `export GOOGLE_API_KEY="${AQ_KEY}"`, `set GEMINI_API_KEY=${AQ_KEY}`, `x-goog-api-key: ${AQ_KEY}`,
    `Authorization: Bearer ${AQ_KEY}`, `https://generativelanguage.googleapis.com/v1beta/models?key=${AQ_KEY}&alt=json`, `${AQ_KEY};`,
  ]) {
    assert.equal(normalizeApiKey(pasted), AQ_KEY, pasted.replace(AQ_KEY, '<chave>'));
    assert.equal(inspectGoogleKey(pasted).key, AQ_KEY);
  }
  assert.equal(normalizeApiKey(undefined), '');
});

test('chave: recusa só enganos evidentes, e o motivo nunca repete a chave', () => {
  const cases: [string, RegExp][] = [
    ['', /vazia/], ['   ', /vazia/], ['sua_chave_aqui', /exemplo/], ['<SUA_CHAVE_DO_GOOGLE>', /exemplo/], ['AIza...', /exemplo/],
    [`${AQ_KEY.slice(0, 20)} ${AQ_KEY.slice(20)}`, /espaços/], [`${AQ_KEY.slice(0, 20)}\n${AQ_KEY.slice(20)}`, /espaços/],
    [`${AQ_KEY}ção`, /acentos/], [`sk-ant-api03-${'a'.repeat(40)}`, /Anthropic/], [`sk-proj-${'a'.repeat(40)}`, /outro provedor/],
    [`ya29.${'a'.repeat(60)}`, /token de acesso/], ['AQ.curta', /curta demais/], ['https://aistudio.google.com/apikey', /endereço/],
    [`AQ.${'a'.repeat(600)}`, /longa demais/],
  ];
  for (const [input, why] of cases) {
    const r = inspectGoogleKey(input);
    assert.equal(r.ok, false, JSON.stringify(input.slice(0, 12)));
    assert.equal(r.key, undefined);
    assert.match(r.problem!, why);
    if (input.trim().length > 12) assert.ok(!r.problem!.includes(input.trim()), 'o motivo não repete o que foi digitado');
  }
});

test('chave: máscara e limpeza de textos', () => {
  const m = maskKey(AQ_KEY);
  assert.ok(m.startsWith('AQ.A') && m.includes(`${AQ_KEY.length} caracteres`));
  assert.ok(!m.includes(AQ_KEY.slice(6, 30)));
  assert.equal(maskKey(undefined), '(nenhuma)');
  assert.match(maskKey('curta'), /^\*\*\*/);
  const dirty = `falhou com ${AQ_KEY} e também ${OLD_KEY} e ${ODD_KEY}`;
  const clean = scrubKeys(dirty, ODD_KEY);
  for (const k of [AQ_KEY, OLD_KEY, ODD_KEY]) assert.ok(!clean.includes(k));
});

// ================================================================ configuração
test('config: GEMINI_API_KEY tem prioridade; GOOGLE_API_KEY serve na falta dela', () => {
  assert.equal(geminiConfig({ GEMINI_API_KEY: AQ_KEY, GOOGLE_API_KEY: OLD_KEY }).geminiApiKey, AQ_KEY);
  const g = geminiConfig({ GOOGLE_API_KEY: `"${OLD_KEY}"` });
  assert.deepEqual([g.geminiApiKey, g.geminiKeySource, g.geminiKeyKind], [OLD_KEY, 'GOOGLE_API_KEY', 'padrao']);
  assert.match(g.geminiKeyWarning!, /formato antigo/);
  const none = geminiConfig({});
  assert.deepEqual([none.geminiApiKey, none.geminiKeyProblem, none.geminiModel, none.geminiApiMode, none.geminiThinkingLevel], [undefined, undefined, GEMINI_DEFAULT_MODEL, 'auto', undefined]);
});

test('config: valor que não é chave vira problema explicado, nunca chave', () => {
  const g = geminiConfig({ GEMINI_API_KEY: 'cole_aqui_a_sua_chave' });
  assert.equal(g.geminiApiKey, undefined);
  assert.match(g.geminiKeyProblem!, /exemplo/);
});

test('config: modelo aceita "models/…", recusa nomes estranhos e valida os demais campos', () => {
  assert.equal(geminiConfig({ GEMINI_MODEL: 'models/gemini-3.5-flash-lite' }).geminiModel, 'gemini-3.5-flash-lite');
  const bad = geminiConfig({ GEMINI_MODEL: 'gemini/../../etc' });
  assert.equal(bad.geminiModel, GEMINI_DEFAULT_MODEL);
  assert.match(bad.geminiModelProblem!, /inválido/);
  assert.equal(geminiConfig({ GEMINI_THINKING_LEVEL: 'LOW' }).geminiThinkingLevel, 'low');
  assert.equal(geminiConfig({ GEMINI_THINKING_LEVEL: 'máximo' }).geminiThinkingLevel, undefined);
  assert.equal(geminiConfig({ GEMINI_API_MODE: 'generate-content' }).geminiApiMode, 'generate-content');
  assert.equal(geminiConfig({ GEMINI_API_MODE: 'qualquer' }).geminiApiMode, 'auto');
  assert.equal(normalizeGeminiModel('  "gemini-flash-latest" '), 'gemini-flash-latest');
  assert.equal(normalizeGeminiModel('a b'), undefined);
});

test('config: a chave passa intacta pelo .env (pontos, hífens e sublinhados)', () => {
  for (const line of [`GEMINI_API_KEY=${AQ_KEY}`, `GEMINI_API_KEY="${AQ_KEY}"`, `GEMINI_API_KEY=${AQ_KEY}   # minha chave`, `  GEMINI_API_KEY = ${AQ_KEY}`]) {
    assert.equal(geminiConfig(parseDotEnv(`LLM_ENABLED=true\n${line}\nLLM_MODEL=claude-haiku-5-5\n`)).geminiApiKey, AQ_KEY, line.replace(AQ_KEY, '<chave>'));
  }
});

// ================================================================ escolha do provedor
test('provedor: auto usa a chave que existe; com as duas mantém a Anthropic e avisa', () => {
  const pick = (o: Parameters<typeof testConfig>[0]) => resolveLlmProvider(testConfig(o));
  assert.deepEqual([pick({ geminiApiKey: AQ_KEY, geminiKeyKind: 'autorizacao' }).provider, pick({ geminiApiKey: AQ_KEY }).apiKey], ['gemini', AQ_KEY]);
  assert.equal(pick({ geminiApiKey: AQ_KEY }).model, GEMINI_DEFAULT_MODEL);
  assert.equal(pick({ anthropicApiKey: 'sk-ant-x' }).provider, 'anthropic');
  const both = pick({ anthropicApiKey: 'sk-ant-x', geminiApiKey: AQ_KEY });
  assert.equal(both.provider, 'anthropic');
  assert.match(both.notes.join(' '), /LLM_PROVIDER=gemini/);
  assert.equal(pick({ anthropicApiKey: 'sk-ant-x', geminiApiKey: AQ_KEY, llmProvider: 'gemini' }).provider, 'gemini');
  const none = pick({});
  assert.equal(none.provider, undefined);
  assert.match(none.reason!, /GEMINI_API_KEY/);
  assert.match(pick({ llmProvider: 'gemini' }).reason!, /GEMINI_API_KEY ausente/);
  assert.match(pick({ geminiKeyProblem: 'isto parece um texto de exemplo, não uma chave', geminiKeySource: 'GEMINI_API_KEY' }).reason!, /não pôde ser usada/);
});

test('provedor: chave do Google colocada em ANTHROPIC_API_KEY é usada no Gemini, com aviso', () => {
  for (const key of [AQ_KEY, OLD_KEY]) {
    const p = resolveLlmProvider(testConfig({ anthropicApiKey: key }));
    assert.deepEqual([p.provider, p.apiKey], ['gemini', key]);
    assert.match(p.notes.join(' '), /mova-a para GEMINI_API_KEY/);
  }
  // Com o provedor fixado na Anthropic, nada é trocado por baixo dos panos: só o aviso.
  const forced = resolveLlmProvider(testConfig({ anthropicApiKey: AQ_KEY, llmProvider: 'anthropic' }));
  assert.deepEqual([forced.provider, forced.apiKey], ['anthropic', AQ_KEY]);
  assert.match(forced.notes.join(' '), /LLM_PROVIDER=gemini/);
});

// ================================================================ Interactions API
test('Interactions: formato do pedido, chave só no cabeçalho e leitura da resposta', async () => {
  const f = fakeFetch(() => ({ json: INTERACTION_OK }));
  const t = createGeminiTransport({ fetchImpl: f.impl });
  const r = await t(CALL, AQ_KEY);
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['x-goog-api-key'], AQ_KEY);
  assert.ok(!c.url.includes(AQ_KEY) && !JSON.stringify(c.body).includes(AQ_KEY), 'a chave não vai no endereço nem no corpo');
  assert.deepEqual(c.body, {
    model: 'gemini-flash-lite-latest', input: 'Dados atuais.', system_instruction: 'Responda só com JSON.',
    generation_config: { max_output_tokens: 1524 }, store: false,
  });
  assert.equal(r.text, '{"resumo":"Sem pontos de atenção.","riscos":[]}');
  assert.deepEqual([r.inputTokens, r.outputTokens], [7, 42], 'tokens de raciocínio contam como saída');
  assert.equal(t.activeApi(), 'interactions');
});

test('Interactions: nível de raciocínio só é enviado quando configurado', async () => {
  const f = fakeFetch(() => ({ json: INTERACTION_OK }));
  await createGeminiTransport({ fetchImpl: f.impl, thinkingLevel: 'low', thinkingHeadroom: 0 })({ ...CALL, system: '' }, AQ_KEY);
  assert.deepEqual(f.calls[0].body.generation_config, { max_output_tokens: 500, thinking_level: 'low' });
  assert.ok(!('system_instruction' in f.calls[0].body));
  assert.ok(!('temperature' in f.calls[0].body.generation_config), 'os modelos atuais ignoram temperature; nunca é enviada');
});

test('qualquer formato de chave é enviado ao Google exatamente como foi informado', async () => {
  for (const key of [AQ_KEY, OLD_KEY, ODD_KEY]) {
    const f = fakeFetch(() => ({ json: INTERACTION_OK }));
    await createGeminiTransport({ fetchImpl: f.impl })(CALL, key);
    assert.equal(f.calls[0].headers['x-goog-api-key'], key);
  }
});

test('Interactions: lê o formato de revisões anteriores e trata resposta sem texto', () => {
  assert.equal(parseInteraction({ status: 'completed', outputs: [{ type: 'thought', summary: 'x' }, { type: 'text', text: 'olá' }], usage: { total_input_tokens: 3, total_output_tokens: 1 } }).text, 'olá');
  assert.equal(parseInteraction([INTERACTION_OK]).inputTokens, 7, 'resposta dentro de lista também é lida');
  assert.equal(parseInteraction({ status: 'incomplete', steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"resumo":"corta' }] }] }).text, '{"resumo":"corta');
  assert.throws(() => parseInteraction({ status: 'incomplete', steps: [], usage: { total_input_tokens: 5, total_thought_tokens: 900 } }), (e: GeminiError) => e.kind === 'resposta' && /limite de tokens/.test(e.message) && e.usage?.outputTokens === 900);
  assert.throws(() => parseInteraction({ status: 'failed', error: { message: 'internal' } }), (e: GeminiError) => e.kind === 'resposta' && /failed/.test(e.message));
  assert.throws(() => parseInteraction('texto'), (e: GeminiError) => e.kind === 'resposta');
});

// ================================================================ erros do Google
test('erro real: chave AQ.… não reconhecida (401, dentro de lista) vira "chave", sem trocar de API', async () => {
  const f = fakeFetch(() => ({ status: 401, json: ERR_AQ_UNKNOWN }));
  const e = await failure(createGeminiTransport({ fetchImpl: f.impl })(CALL, AQ_KEY));
  assert.deepEqual([e.kind, e.httpStatus, e.shape, e.transient], ['chave', 401, false, false]);
  assert.match(e.message, /não reconhece esta chave de autorização/);
  assert.match(e.message, /aistudio\.google\.com\/apikey/);
  assert.equal(f.calls.length, 1, 'erro de chave não tenta a outra API nem repete');
  assert.ok(!e.message.includes(AQ_KEY));
});

test('erro real: chave em outro formato não reconhecida (400 API_KEY_INVALID) vira "chave"', async () => {
  for (const [key, body] of [[OLD_KEY, [ERR_KEY_INVALID]], [ODD_KEY, ERR_KEY_INVALID]] as const) {
    const f = fakeFetch(() => ({ status: 400, json: body }));
    const e = await failure(createGeminiTransport({ fetchImpl: f.impl })(CALL, key));
    assert.equal(e.kind, 'chave');
    assert.equal(f.calls.length, 1);
    assert.match(e.message, /API key not valid/, 'a explicação do Google acompanha a mensagem');
  }
});

test('erros: cota, modelo fora do nível gratuito, modelo inexistente, permissão, pagamento e região', async () => {
  const run = async (status: number, json: unknown, api: 'interactions' | 'generate-content' = 'interactions') => {
    const f = fakeFetch(() => ({ status, json }));
    const e = await failure(createGeminiTransport({ fetchImpl: f.impl, mode: api })(CALL, AQ_KEY));
    return { e, n: f.calls.length };
  };
  const quota = await run(429, ERR_QUOTA);
  assert.equal(quota.e.kind, 'cota');
  assert.match(quota.e.message, /nova tentativa em 47 s/);
  assert.equal(quota.n, 1, 'cota não é repetida');
  assert.match((await run(429, ERR_NOT_FREE)).e.message, /não está no nível gratuito/);
  const model = await run(404, [{ error: { code: 'model_not_found', message: 'The specified model was not found.' } }]);
  assert.deepEqual([model.e.kind, model.e.shape], ['modelo', false]);
  assert.match(model.e.message, /GEMINI_MODEL/);
  assert.equal((await run(404, { error: { code: 404, message: 'models/x is not found for API version v1beta', status: 'NOT_FOUND' } }, 'generate-content')).e.kind, 'modelo');
  const leaked = await run(403, { error: { code: 403, message: 'Your API key was reported as leaked. Please use another API key.', status: 'PERMISSION_DENIED' } });
  assert.equal(leaked.e.kind, 'permissao');
  assert.match(leaked.e.message, /vazada/);
  assert.match((await run(403, { error: { code: 'permission_denied', message: 'Your project has been denied access.' } })).e.message, /projeto restrito/);
  assert.equal((await run(402, { error: { code: 'payment_required', message: 'Prepay credit balance is depleted.' } })).e.kind, 'pagamento');
  const region = await run(400, { error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' } });
  assert.deepEqual([region.e.kind, region.e.shape], ['permissao', false]);
});

test('erros: a mensagem nunca carrega a chave, mesmo se o Google a devolver', async () => {
  const f = fakeFetch(() => ({ status: 403, json: { error: { code: 403, message: `Key ${AQ_KEY} is not allowed. Also seen: ${OLD_KEY}`, status: 'PERMISSION_DENIED' } } }));
  const e = await failure(createGeminiTransport({ fetchImpl: f.impl })(CALL, AQ_KEY));
  assert.ok(!e.message.includes(AQ_KEY) && !e.message.includes(OLD_KEY));
  assert.match(e.message, /\*\*\*/);
});

// ================================================================ troca automática de API
test('auto: formato recusado na Interactions → tenta a generateContent e passa a usá-la', async () => {
  const f = fakeFetch((c) => (c.url.endsWith('/interactions') ? { status: 400, json: ERR_SHAPE } : { json: GENERATE_OK }));
  const switched: string[] = [];
  const t = createGeminiTransport({ fetchImpl: f.impl, onFallback: (to) => switched.push(to) });
  const r = await t(CALL, AQ_KEY);
  assert.equal(r.text, '{"resumo":"Tudo certo.","riscos":[]}');
  assert.deepEqual(f.calls.map((c) => c.url.split('/v1beta/')[1]), ['interactions', 'models/gemini-flash-lite-latest:generateContent']);
  assert.deepEqual(switched, ['generate-content']);
  assert.equal(t.activeApi(), 'generate-content');
  await t(CALL, AQ_KEY);
  assert.equal(f.calls.length, 3, 'depois da troca, vai direto na API que funcionou');
  assert.match(f.calls[2].url, /:generateContent$/);
});

test('auto: endereço inexistente (404 em HTML) também troca de API; modo fixo não troca', async () => {
  const html = (c: Call): Reply => (c.url.endsWith('/interactions') ? { status: 404, text: '<html>Not Found</html>', contentType: 'text/html' } : { json: GENERATE_OK });
  const auto = fakeFetch(html);
  assert.equal((await createGeminiTransport({ fetchImpl: auto.impl })(CALL, AQ_KEY)).inputTokens, 9);
  assert.equal(auto.calls.length, 2);
  const fixed = fakeFetch(html);
  const e = await failure(createGeminiTransport({ fetchImpl: fixed.impl, mode: 'interactions' })(CALL, AQ_KEY));
  assert.deepEqual([e.kind, fixed.calls.length], ['requisicao', 1]);
});

test('auto: se as duas APIs recusam, vale o primeiro erro e nada muda', async () => {
  const f = fakeFetch((c) => (c.url.endsWith('/interactions') ? { status: 400, json: ERR_SHAPE } : { status: 400, json: { error: { code: 400, message: 'outro motivo', status: 'INVALID_ARGUMENT' } } }));
  const t = createGeminiTransport({ fetchImpl: f.impl });
  const e = await failure(t(CALL, AQ_KEY));
  assert.match(e.message, /Unknown name "store"/);
  assert.equal(t.activeApi(), 'interactions');
});

// ================================================================ falhas passageiras
test('falha passageira: uma nova tentativa em 503 e em queda de conexão; nenhuma em tempo esgotado', async () => {
  const flaky = fakeFetch((_c, n) => (n === 1 ? { status: 503, json: { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } } } : { json: INTERACTION_OK }));
  assert.equal((await createGeminiTransport({ fetchImpl: flaky.impl, ...fast })(CALL, AQ_KEY)).inputTokens, 7);
  assert.equal(flaky.calls.length, 2);

  const down = fakeFetch(() => new TypeError('fetch failed'));
  const e = await failure(createGeminiTransport({ fetchImpl: down.impl, ...fast })(CALL, AQ_KEY));
  assert.deepEqual([e.kind, down.calls.length], ['rede', 2]);
  assert.match(e.message, /sem conexão com o Google/);

  const slow = fakeFetch(() => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  const t = await failure(createGeminiTransport({ fetchImpl: slow.impl, timeoutMs: 20_000, ...fast })(CALL, AQ_KEY));
  assert.deepEqual([t.kind, slow.calls.length], ['rede', 1]);
  assert.match(t.message, /não respondeu em 20 s/);
});

// ================================================================ generateContent (legada)
test('generateContent: formato do pedido e leitura (ignora o raciocínio, soma os tokens)', async () => {
  const f = fakeFetch(() => ({ json: GENERATE_OK }));
  const r = await createGeminiTransport({ fetchImpl: f.impl, mode: 'generate-content', thinkingLevel: 'minimal' })({ ...CALL, model: 'models/gemini-3.5-flash-lite' }, OLD_KEY);
  const c = f.calls[0];
  assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(c.headers['x-goog-api-key'], OLD_KEY);
  assert.deepEqual(c.body, {
    contents: [{ role: 'user', parts: [{ text: 'Dados atuais.' }] }],
    generationConfig: { maxOutputTokens: 1524, thinkingConfig: { thinkingLevel: 'minimal' } },
    system_instruction: { parts: [{ text: 'Responda só com JSON.' }] },
  });
  assert.deepEqual([r.text, r.inputTokens, r.outputTokens], ['{"resumo":"Tudo certo.","riscos":[]}', 9, 42]);
});

test('generateContent: bloqueio por filtro e resposta cortada viram erro de resposta, com os tokens gastos', () => {
  assert.throws(() => parseGenerateContent({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 4 } }), (e: GeminiError) => e.kind === 'resposta' && /SAFETY/.test(e.message) && e.usage?.inputTokens === 4);
  assert.throws(() => parseGenerateContent({ candidates: [{ content: { parts: [{ text: 'só raciocínio', thought: true }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 4, thoughtsTokenCount: 1500 } }), (e: GeminiError) => /limite de tokens/.test(e.message) && e.usage?.outputTokens === 1500);
  assert.throws(() => parseGenerateContent({ candidates: [] }), (e: GeminiError) => /nenhum candidato/.test(e.message));
});

test('modelo com nome inválido é recusado antes de qualquer chamada', async () => {
  const f = fakeFetch(() => ({ json: INTERACTION_OK }));
  const e = await failure(createGeminiTransport({ fetchImpl: f.impl })({ ...CALL, model: '../../v1/files?x=' }, AQ_KEY));
  assert.deepEqual([e.kind, f.calls.length], ['modelo', 0]);
});

// ================================================================ verificação da chave
test('verificação: sucesso, chave recusada e modelo inexistente com sugestão de modelos', async () => {
  const ok = await checkGeminiKey(AQ_KEY, GEMINI_DEFAULT_MODEL, { fetchImpl: fakeFetch(() => ({ json: INTERACTION_OK })).impl });
  assert.deepEqual([ok.ok, ok.api, ok.inputTokens], [true, 'interactions', 7]);
  assert.match(describeCheck(ok).join('\n'), /^\[OK\] o Google aceitou a chave/);

  const bad = await checkGeminiKey(AQ_KEY, GEMINI_DEFAULT_MODEL, { fetchImpl: fakeFetch(() => ({ status: 401, json: ERR_AQ_UNKNOWN })).impl });
  assert.deepEqual([bad.ok, bad.kind, bad.httpStatus], [false, 'chave', 401]);
  const text = describeCheck(bad).join('\n');
  assert.match(text, /^\[ERRO\] o Google recusou a chave/);
  assert.match(text, /O que fazer: Abra https:\/\/aistudio\.google\.com\/apikey/);
  assert.doesNotMatch(text, /\.\.(\n|$)/, 'sem ponto final duplicado');
  assert.ok(!text.includes(AQ_KEY));

  const models = { models: [
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemma-4-31b-it', supportedGenerationMethods: ['generateContent'] },
  ] };
  const f = fakeFetch((c) => (c.method === 'GET' ? { json: models } : { status: 404, json: [{ error: { code: 'model_not_found', message: 'The specified model was not found.' } }] }));
  const missing = await checkGeminiKey(AQ_KEY, 'gemini-9-ultra', { fetchImpl: f.impl });
  assert.deepEqual([missing.ok, missing.kind], [false, 'modelo']);
  assert.deepEqual(missing.models, ['gemini-3.5-flash-lite', 'gemini-3.8-flash'], 'só modelos de texto, Flash-Lite primeiro');
  assert.equal(f.calls.at(-1)!.headers['x-goog-api-key'], AQ_KEY);
  assert.ok(!f.calls.at(-1)!.url.includes(AQ_KEY));
  assert.deepEqual(await listGeminiModels(AQ_KEY, { fetchImpl: fakeFetch(() => ({ status: 500, text: 'erro' })).impl }), [], 'falha ao listar não derruba a verificação');
});

test('verificação: resposta sem texto ainda prova que a chave foi aceita', async () => {
  const r = await checkGeminiKey(AQ_KEY, 'gemini-3.8-flash', { fetchImpl: fakeFetch(() => ({ json: { status: 'incomplete', steps: [], usage: { total_input_tokens: 5, total_thought_tokens: 1040 } } })).impl });
  assert.equal(r.ok, true);
  assert.match(r.message, /sem texto neste teste/);
});

// ================================================================ gateway
const geminiOn = { llmEnabled: true, geminiApiKey: AQ_KEY, geminiKeyKind: 'autorizacao' as const };

test('gateway: usa o Gemini, registra o consumo e nunca expõe a chave no estado', async () => {
  const f = fakeFetch(() => ({ json: INTERACTION_OK }));
  const app = makeApp(geminiOn, { fetchImpl: f.impl });
  const before = app.llm.status();
  assert.deepEqual([before.enabled, before.provider, before.model, before.keyKind, before.api], [true, 'gemini', GEMINI_DEFAULT_MODEL, 'autorizacao', 'interactions']);
  const r = await app.llm.complete({ agentId: 34, purpose: 't', system: 's', prompt: 'p', maxTokens: 500 });
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].headers['x-goog-api-key'], AQ_KEY);
  const after = app.llm.status();
  assert.deepEqual([after.callsToday, after.tokensThisMonth, after.last?.ok], [1, 49, true]);
  assert.ok(!JSON.stringify(after).includes(AQ_KEY));
});

test('gateway: limites diário e mensal valem para o Gemini', async () => {
  const f = fakeFetch(() => ({ json: INTERACTION_OK }));
  const app = makeApp({ ...geminiOn, llmMaxCallsPerDay: 2 }, { fetchImpl: f.impl });
  for (let i = 0; i < 4; i++) await app.llm.complete({ agentId: 34, purpose: 't', system: 's', prompt: 'p' });
  assert.equal(f.calls.length, 2);
  assert.match(app.llm.status().reason!, /limite diário/);
  const tight = makeApp({ ...geminiOn, llmMaxTokensPerMonth: 40 }, { fetchImpl: f.impl });
  await tight.llm.complete({ agentId: 34, purpose: 't', system: 's', prompt: 'p' });
  assert.match(tight.llm.status().reason!, /limite mensal/);
});

test('gateway: chave recusada fica registrada sem a chave, conta no limite e gera alerta no A33', async () => {
  const f = fakeFetch(() => ({ status: 401, json: ERR_AQ_UNKNOWN }));
  const app = makeApp(geminiOn, { fetchImpl: f.impl });
  const r = await app.llm.complete({ agentId: 34, purpose: 't', system: 's', prompt: 'p' });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /falha na chamada: o Google recusou a chave/);
  const s = app.llm.status();
  assert.deepEqual([s.last?.ok, s.last?.kind, s.callsToday], [false, 'chave', 1]);
  assert.ok(!JSON.stringify(s).includes(AQ_KEY));
  assert.ok(!JSON.stringify(app.store.db.prepare('SELECT * FROM llm_usage').all()).includes(AQ_KEY));

  await app.runtime.runOnce(33);
  const alerts = app.store.listAlerts({ openOnly: true, limit: 50 });
  assert.ok(alerts.some((a) => a.code === 'llm.chave' && /recusou a chave/.test(a.message)));
  assert.ok(!JSON.stringify(alerts).includes(AQ_KEY));
  assert.equal(app.store.latestMetric('llm.provider')?.value, 'gemini');
  const h = (await app.runtime.checkHealth(33))!;
  assert.ok(h.checks.some((c) => c.name === 'proprio' && c.level === 'falha' && /última chamada ao gemini falhou/.test(c.detail)));
});

test('gateway: tokens gastos em resposta sem texto entram no limite mensal', async () => {
  const f = fakeFetch(() => ({ json: { status: 'incomplete', steps: [], usage: { total_input_tokens: 5, total_thought_tokens: 900 } } }));
  const app = makeApp(geminiOn, { fetchImpl: f.impl });
  assert.equal((await app.llm.complete({ agentId: 34, purpose: 't', system: 's', prompt: 'p' })).ok, false);
  assert.equal(app.llm.status().tokensThisMonth, 905);
});

test('gateway: chave do Google em ANTHROPIC_API_KEY chama o Google, não a Anthropic', async () => {
  const f = fakeFetch(() => ({ json: INTERACTION_OK }));
  const app = makeApp({ llmEnabled: true, anthropicApiKey: AQ_KEY }, { fetchImpl: f.impl });
  assert.equal((await app.llm.complete({ agentId: 34, purpose: 't', system: 's', prompt: 'p' })).ok, true);
  assert.match(f.calls[0].url, /^https:\/\/generativelanguage\.googleapis\.com\//);
  assert.match(app.llm.status().notes.join(' '), /mova-a para GEMINI_API_KEY/);
});

test('gateway: chave no formato antigo funciona e o aviso aparece no estado', async () => {
  const f = fakeFetch(() => ({ json: INTERACTION_OK }));
  const app = makeApp({ llmEnabled: true, geminiApiKey: OLD_KEY, geminiKeyKind: 'padrao', geminiKeyWarning: inspectGoogleKey(OLD_KEY).warning }, { fetchImpl: f.impl });
  assert.equal((await app.llm.complete({ agentId: 34, purpose: 't', system: 's', prompt: 'p' })).ok, true);
  assert.equal(f.calls[0].headers['x-goog-api-key'], OLD_KEY);
  assert.match(app.llm.status().notes.join(' '), /formato antigo/);
});

test('Redator (A34): análise do Gemini é usada quando válida e descartada quando promete lucro', async () => {
  const good = makeApp(geminiOn, { fetchImpl: fakeFetch(() => ({ json: INTERACTION_OK })).impl });
  await good.runtime.runOnce(34);
  const ok = good.store.latestReport('analysis')!.body as { fonte: string; resumo: string };
  assert.deepEqual([ok.fonte, ok.resumo], ['llm', 'Sem pontos de atenção.']);

  const promise = { ...INTERACTION_OK, steps: [{ type: 'model_output', content: [{ type: 'text', text: '```json\n{"resumo":"Lucro garantido de 999999 por dia!","riscos":[]}\n```' }] }] };
  const bad = makeApp(geminiOn, { fetchImpl: fakeFetch(() => ({ json: promise })).impl });
  await bad.runtime.runOnce(34);
  const fallback = bad.store.latestReport('analysis')!.body as { fonte: string; observacao: string };
  assert.equal(fallback.fonte, 'determinístico');
  assert.match(fallback.observacao, /rejeitada/);

  const down = makeApp(geminiOn, { fetchImpl: fakeFetch(() => ({ status: 429, json: ERR_QUOTA })).impl });
  await down.runtime.runOnce(34);
  const quota = down.store.latestReport('analysis')!.body as { fonte: string; observacao: string };
  assert.equal(quota.fonte, 'determinístico');
  assert.match(quota.observacao, /limite de uso do Gemini/);
  assert.notEqual(down.runtime.agent(34)!.state, 'erro', 'falha do LLM não derruba o agente');
});

test('Redator (A34): o Gemini recebe só o retrato das métricas, sem segredos da configuração', async () => {
  const f = fakeFetch(() => ({ json: INTERACTION_OK }));
  const app = makeApp({ ...geminiOn, apiToken: 'token-do-painel-0123456789', luxorApiKey: 'luxor-secreta-0123456789', walletBtcAddress: 'bc1qenderecodeteste0123456789' }, { fetchImpl: f.impl });
  for (const id of [6, 7, 8, 11, 12, 13, 16, 17, 18, 22, 26, 1]) await app.runtime.runOnce(id);
  await app.runtime.runOnce(34);
  const sent = JSON.stringify(f.calls.at(-1)!.body);
  for (const secret of [AQ_KEY, 'token-do-painel-0123456789', 'luxor-secreta-0123456789', 'bc1qenderecodeteste0123456789']) assert.ok(!sent.includes(secret));
  assert.match(sent, /procedencia/);
  assert.equal(f.calls.at(-1)!.body.store, false);
});

// ================================================================ agentes de configuração
test('A27 conta a chave do Gemini no cofre; A05 avisa sobre chave inutilizável e LLM desligado', async () => {
  const app = makeApp(geminiOn);
  await app.runtime.runOnce(27);
  assert.match(app.runtime.agent(27)!.lastSummary!, /GEMINI_API_KEY/);
  assert.ok(!app.runtime.agent(27)!.lastSummary!.includes(AQ_KEY));

  const warn = async (o: Parameters<typeof makeApp>[0]) => {
    const a = makeApp(o);
    await a.runtime.runOnce(5);
    return a.store.listAlerts({ openOnly: true, limit: 20 }).filter((x) => x.code === 'config.warnings').map((x) => x.message).join(' ');
  };
  assert.match(await warn({ llmEnabled: true }), /LLM_ENABLED sem chave utilizável/);
  assert.match(await warn({ llmEnabled: true, geminiKeyProblem: 'isto parece um texto de exemplo, não uma chave', geminiKeySource: 'GEMINI_API_KEY' }), /GEMINI_API_KEY não pôde ser usada/);
  assert.match(await warn({ geminiApiKey: AQ_KEY }), /LLM_ENABLED=false: o LLM continua desligado/);
  assert.match(await warn({ llmEnabled: true, anthropicApiKey: 'sk-ant-x', geminiApiKey: AQ_KEY }), /LLM_PROVIDER=gemini/);
  assert.doesNotMatch(await warn(geminiOn), /LLM/);
});

// ================================================================ API
test('API: estado e teste do LLM funcionam e nunca devolvem a chave', async () => {
  const f = fakeFetch((_c, n) => (n === 1 ? { json: INTERACTION_OK } : { status: 401, json: ERR_AQ_UNKNOWN }));
  const app = makeApp(geminiOn, { fetchImpl: f.impl });
  const server = createApiServer(app, 'web');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const seen: string[] = [];
  const get = async (path: string, init?: RequestInit) => { const t = await (await fetch(base + path, init)).text(); seen.push(t); return JSON.parse(t); };
  try {
    const st = await get('/api/llm/status');
    assert.deepEqual([st.enabled, st.provider, st.model, st.keyKind, st.validation], [true, 'gemini', GEMINI_DEFAULT_MODEL, 'autorizacao', null]);
    const ok = await get('/api/llm/validate', { method: 'POST' });
    assert.equal(ok.validation.ok, true);
    assert.match(ok.validation.detail, /o Google aceitou a chave/);
    assert.equal(f.calls[0].body.generation_config.max_output_tokens, 16 + 1024);
    const bad = await get('/api/llm/validate', { method: 'POST' });
    assert.equal(bad.validation.ok, false);
    assert.match(bad.validation.detail, /recusou a chave/);
    assert.equal((await get('/api/llm/status')).validation.ok, false, 'o último teste fica guardado');
    const summary = await get('/api/summary');
    assert.equal(summary.llm.provider, 'gemini');
    await get('/api/events?limit=50');
    await get('/api/alerts');
    await get('/api/agents/33');
    for (const body of seen) assert.ok(!body.includes(AQ_KEY), 'nenhuma resposta da API contém a chave');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ================================================================ ferramenta de configuração
test('gemini:setup: grava a chave e liga o LLM preservando o resto do .env', () => {
  const example = readFileSync('.env.example', 'utf8');
  const out = applyGeminiEnv(example, AQ_KEY);
  const env = parseDotEnv(out);
  assert.deepEqual([env.LLM_ENABLED, env.LLM_PROVIDER, env.GEMINI_API_KEY, env.GEMINI_MODEL], ['true', 'gemini', AQ_KEY, 'gemini-flash-lite-latest']);
  assert.equal(geminiConfig(env).geminiApiKey, AQ_KEY);
  assert.equal(out.match(/^GEMINI_API_KEY=/gm)!.length, 1, 'substitui a linha comentada em vez de duplicar');
  assert.equal(out.match(/^LLM_ENABLED=/gm)!.length, 1);
  const untouched = (t: string) => t.split('\n').filter((l) => !/^\s*#?\s*(LLM_ENABLED|LLM_PROVIDER|GEMINI_API_KEY)=/.test(l)).join('\n');
  assert.equal(untouched(out), untouched(example), 'nenhuma outra linha muda');
  assert.equal(applyGeminiEnv(out, AQ_KEY), out, 'rodar de novo não muda nada');
  assert.equal(parseDotEnv(applyGeminiEnv(out, OLD_KEY, 'gemini-3.8-flash')).GEMINI_MODEL, 'gemini-3.8-flash');
  // .env mínimo, sem as linhas: elas são acrescentadas
  const minimal = parseDotEnv(applyGeminiEnv('HOST=127.0.0.1\n', `${AQ_KEY}`));
  assert.deepEqual([minimal.HOST, minimal.LLM_ENABLED, minimal.GEMINI_API_KEY], ['127.0.0.1', 'true', AQ_KEY]);
});

test('modelos de ambiente: sem chave preenchida e com o LLM desligado', () => {
  for (const file of ['.env.example', '.env.luxor.example']) {
    const env = parseDotEnv(readFileSync(file, 'utf8'));
    const g = geminiConfig(env);
    assert.deepEqual([env.LLM_ENABLED, g.geminiApiKey, g.geminiKeyProblem, g.geminiModel], ['false', undefined, undefined, GEMINI_DEFAULT_MODEL], file);
  }
});
