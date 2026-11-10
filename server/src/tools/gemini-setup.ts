// Configura o Gemini no .env: npm run gemini:setup (chamado pelo Configurar-Gemini.bat).
//  - pede a chave do Google AI Studio (ela não aparece na tela ao colar);
//  - aceita qualquer formato emitido pelo Google (AQ.…, AIza… ou outro): quem decide se a chave vale
//    é o Google, em um teste real, não o prefixo;
//  - grava GEMINI_API_KEY, LLM_PROVIDER=gemini e LLM_ENABLED=true no .env deste computador.
// A chave fica só no .env (que o Git ignora) e só é enviada ao Google.
// Opções: --chave <chave>   sem perguntar     --modelo <código>     --forcar   grava mesmo se o teste falhar
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { checkGeminiKey, GEMINI_DEFAULT_MODEL, normalizeGeminiModel } from '../core/gemini.ts';
import { describeKeyKind, inspectGoogleKey, maskKey } from '../core/llmKeys.ts';
import { describeCheck } from './gemini-check.ts';

function setEnvKey(text: string, key: string, value: string, note = ''): string {
  const line = `${key}=${value}${note ? `    # ${note}` : ''}`;
  const re = new RegExp(`^[ \\t]*#?[ \\t]*${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
}

/** Grava a chave e liga o LLM com o Gemini, preservando o resto do .env. */
export function applyGeminiEnv(text: string, key: string, model?: string): string {
  let out = setEnvKey(text, 'LLM_ENABLED', 'true', 'ligado por npm run gemini:setup');
  out = setEnvKey(out, 'LLM_PROVIDER', 'gemini');
  out = setEnvKey(out, 'GEMINI_API_KEY', key);
  if (model) out = setEnvKey(out, 'GEMINI_MODEL', model);
  return out;
}

/** Pergunta no terminal. Com hidden, o que é digitado ou colado não aparece na tela. */
function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
    const muted = rl as unknown as { _writeToOutput?: (s: string) => void };
    let asked = false;
    if (hidden && process.stdin.isTTY) {
      muted._writeToOutput = (s: string) => {
        if (!asked || s.includes('\n') || s.includes('\r')) process.stdout.write(asked ? '\n' : s);
      };
    }
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
    asked = true;
  });
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<number> {
  const envPath = '.env';
  if (!existsSync(envPath)) copyFileSync('.env.example', envPath);
  const interactive = process.stdin.isTTY === true && !arg('--chave');
  console.log('');
  console.log('==================== CONFIGURAR O GEMINI ====================');
  console.log(' 1. Abra https://aistudio.google.com/apikey e entre com a sua conta Google.');
  console.log(' 2. Clique em "Create API key" e copie a chave (as novas começam com AQ.).');
  console.log(' O nível gratuito não pede cartão. Nele, o Google pode usar os dados enviados');
  console.log(' para melhorar os produtos dele; o painel envia só o resumo das métricas.');
  console.log('=============================================================');

  let insp = inspectGoogleKey(arg('--chave'));
  if (arg('--chave') !== undefined) {
    if (!insp.ok) console.log(`[ERRO] Não parece uma chave: ${insp.problem}.`);
  } else {
    // No terminal, até três tentativas; com a chave vinda por redirecionamento (pipe), uma só.
    for (let tries = 0; tries < (interactive ? 3 : 1); tries++) {
      insp = inspectGoogleKey(await ask(interactive ? ' Cole a chave aqui e aperte Enter (ela não aparece na tela): ' : '', interactive));
      if (insp.ok) break;
      console.log(`[ERRO] Não parece uma chave: ${insp.problem}.`);
    }
  }
  if (!insp.ok || !insp.key) {
    console.log(' Nada foi gravado. Rode de novo quando tiver a chave.');
    return 1;
  }
  console.log(` Chave recebida: ${maskKey(insp.key)} · ${describeKeyKind(insp.kind)}`);
  if (insp.warning) console.log(` Aviso: ${insp.warning}.`);

  const model = normalizeGeminiModel(arg('--modelo')) ?? normalizeGeminiModel(/^GEMINI_MODEL=[ \t]*([^\s#]+)/m.exec(readFileSync(envPath, 'utf8'))?.[1]) ?? GEMINI_DEFAULT_MODEL;
  console.log(` Testando com o Google no modelo ${model}…`);
  let r = await checkGeminiKey(insp.key, model);
  for (const l of describeCheck(r)) console.log(l);
  // O modelo padrão não existe para esta chave: tenta o primeiro modelo de texto que ela enxerga.
  let chosen = arg('--modelo') ? model : undefined;
  if (!r.ok && r.kind === 'modelo' && r.models?.length && !arg('--modelo')) {
    console.log(` Tentando o modelo ${r.models[0]}…`);
    const again = await checkGeminiKey(insp.key, r.models[0]);
    for (const l of describeCheck(again)) console.log(l);
    if (again.ok) { r = again; chosen = again.model; }
  }

  let save = r.ok || r.kind === 'rede' || r.kind === 'servico' || process.argv.includes('--forcar');
  if (!save && interactive) save = /^s/i.test((await ask(' O teste falhou. Gravar a chave mesmo assim? (s/N) ')).trim());
  if (!save) {
    console.log(' Nada foi gravado no .env.');
    return 1;
  }
  writeFileSync(envPath, applyGeminiEnv(readFileSync(envPath, 'utf8'), insp.key, chosen));
  console.log('');
  console.log(r.ok ? ' Pronto: chave gravada no .env e LLM ligado com o Gemini.' : ' Chave gravada no .env, mas o teste não passou: confira com "npm run gemini:check".');
  console.log(' Abra (ou reinicie) o painel pelo Iniciar-Painel.bat. O estado do LLM aparece em Guardião.');
  console.log(' O .env fica só neste computador e o Git o ignora. Não compartilhe a chave.');
  console.log('');
  return r.ok ? 0 : 1;
}

if (process.argv[1]?.endsWith('gemini-setup.ts')) main().then((code) => process.exit(code));
