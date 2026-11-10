// Chaves de API do Google (Gemini): normalização e inspeção tolerante.
//
// Regra central: o FORMATO NÃO DECIDE se a chave vale. Quem decide é o Google, na primeira chamada.
// Em 2026 o Google AI Studio trocou as chaves "padrão" (AIza…) pelas chaves de autorização (AQ.…),
// e várias ferramentas pararam de funcionar porque exigiam o prefixo antigo. Aqui só são recusados
// enganos evidentes de configuração: campo vazio, texto de exemplo, espaços no meio ou chave de
// outro provedor. Qualquer outra coisa segue para o Google do jeito que foi informada.

/** autorizacao = AQ.… (formato atual do AI Studio); padrao = AIza… (formato antigo); desconhecido = outro formato. */
export type GoogleKeyKind = 'autorizacao' | 'padrao' | 'desconhecido';

export interface KeyInspection {
  ok: boolean;
  /** Chave pronta para uso (só quando ok). */
  key?: string;
  kind?: GoogleKeyKind;
  /** Motivo da recusa (quando !ok). Nunca contém a chave. */
  problem?: string;
  /** Observação que não impede o uso. Nunca contém a chave. */
  warning?: string;
}

const QUOTES = '"\'`“”‘’';
const QUOTE_EDGES = new RegExp(`^[${QUOTES}]+|[${QUOTES}]+$`, 'g');
const PLACEHOLDER = /^<.*>$|^x{6,}$|\.{3}|…|sua[_ -]?chave|your[_ -]?(api[_ -]?)?key|cole[_ -]?aqui|coloque|insira|preencha|changeme|exemplo|example/i;

/**
 * Limpa o que costuma vir junto quando a chave é copiada: aspas, espaços nas pontas, caracteres
 * invisíveis e o nome da variável ou do cabeçalho (GEMINI_API_KEY=…, x-goog-api-key: …, ?key=…).
 */
export function normalizeApiKey(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) return '';
  let s = String(raw).replace(/[​-‍﻿]/g, '').replace(/ /g, ' ').trim();
  s = s.replace(QUOTE_EDGES, '').trim();
  s = s.replace(/^(?:export\s+|set\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_API_KEY|API_KEY)\s*[=:]\s*/i, '');
  s = s.replace(/^x-goog-api-key\s*:\s*/i, '').replace(/^(?:authorization\s*:\s*)?bearer\s+/i, '');
  const inUrl = /[?&]key=([^&\s#]+)/.exec(s);
  if (inUrl) {
    try { s = decodeURIComponent(inUrl[1]); } catch { s = inUrl[1]; }
  }
  return s.replace(QUOTE_EDGES, '').replace(/[;,]+$/, '').trim();
}

/** Inspeciona uma chave do Google sem exigir prefixo nem tamanho exatos. */
export function inspectGoogleKey(raw: string | undefined | null): KeyInspection {
  const key = normalizeApiKey(raw);
  const no = (problem: string): KeyInspection => ({ ok: false, problem });
  if (!key) return no('chave vazia');
  if (/^https?:\/\//i.test(key)) return no('isto é um endereço, não uma chave');
  if (/\s/.test(key)) return no('a chave contém espaços ou quebras de linha; copie de novo, em uma linha só');
  if (/[^\x21-\x7E]/.test(key)) return no('a chave contém acentos ou símbolos que não fazem parte de uma chave; copie de novo');
  if (PLACEHOLDER.test(key)) return no('isto parece um texto de exemplo, não uma chave');
  if (/^sk-ant-/i.test(key)) return no('esta é uma chave da Anthropic (sk-ant-…); use ANTHROPIC_API_KEY');
  if (/^(sk-|xai-|gsk_|pplx-|hf_|r8_)/.test(key)) return no('esta chave é de outro provedor, não do Google');
  if (/^ya29\./.test(key)) return no('isto é um token de acesso temporário (ya29.…), não uma chave de API; crie uma chave no Google AI Studio');
  if (key.length < 20) return no('curta demais para ser uma chave do Google (menos de 20 caracteres); pode ter sido copiada pela metade');
  if (key.length > 512) return no('longa demais para ser uma chave de API');

  if (/^AQ\./.test(key)) return { ok: true, key, kind: 'autorizacao' };
  if (/^AIza[0-9A-Za-z_-]{35}$/.test(key)) {
    return {
      ok: true, key, kind: 'padrao',
      warning: 'chave no formato antigo (AIza…): o Google anunciou que deixaria de aceitar chaves padrão em setembro de 2026; se for recusada, crie uma nova no Google AI Studio',
    };
  }
  if (/^AIza/.test(key)) {
    return { ok: true, key, kind: 'desconhecido', warning: 'começa com AIza, mas não tem os 39 caracteres do formato antigo; confira se foi copiada inteira' };
  }
  return { ok: true, key, kind: 'desconhecido', warning: 'formato não reconhecido; a chave será enviada ao Google assim mesmo, e ele decide se vale' };
}

/** Nome do formato, para mensagens. */
export function describeKeyKind(kind: GoogleKeyKind | undefined): string {
  if (kind === 'autorizacao') return 'chave de autorização (AQ.…), o formato atual do Google AI Studio';
  if (kind === 'padrao') return 'chave padrão (AIza…), o formato antigo';
  return 'formato não reconhecido';
}

/** Mostra só as pontas da chave, para o operador conferir qual é sem expô-la. */
export function maskKey(key: string | undefined): string {
  if (!key) return '(nenhuma)';
  if (key.length < 16) return `*** (${key.length} caracteres)`;
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} caracteres)`;
}

/** Remove de um texto qualquer coisa com cara de chave (mensagens de erro vindas de fora). */
export function scrubKeys(text: string, ...known: (string | undefined)[]): string {
  let out = text;
  for (const k of known) if (k && k.length >= 8) out = out.split(k).join('***');
  return out
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '***')
    .replace(/AQ\.[0-9A-Za-z_.-]{20,}/g, '***')
    .replace(/sk-ant-[0-9A-Za-z_-]{10,}/g, '***');
}
