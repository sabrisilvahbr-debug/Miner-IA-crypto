// Confere a chave do Gemini com o próprio Google: npm run gemini:check
// O formato da chave não prova nada (o Google já trocou AIza… por AQ.…): o teste que vale é uma
// geração mínima no modelo configurado. Mostra só as pontas da chave e nunca a envia a outro lugar.
// Opções: --modelo <código>   testa outro modelo sem mexer no .env
import { loadConfig } from '../config.ts';
import { checkGeminiKey, normalizeGeminiModel, type GeminiCheck } from '../core/gemini.ts';
import { describeKeyKind, maskKey } from '../core/llmKeys.ts';
import { resolveLlmProvider } from '../core/llmGateway.ts';

const HELP: Record<string, string> = {
  chave: 'Abra https://aistudio.google.com/apikey, crie uma chave nova, copie-a inteira e rode o Configurar-Gemini.bat de novo.',
  permissao: 'Veja em https://aistudio.google.com/apikey se o projeto da chave aparece como restrito ou se a chave foi bloqueada. Uma chave nova em um projeto novo costuma resolver.',
  pagamento: 'O projeto da chave usa créditos pré-pagos e eles acabaram. Recarregue no Google AI Studio ou use uma chave de um projeto no nível gratuito.',
  modelo: 'Defina GEMINI_MODEL no .env com um dos modelos listados acima.',
  cota: 'Espere a cota voltar (os limites do nível gratuito são por minuto e por dia) ou escolha outro modelo em GEMINI_MODEL.',
  requisicao: 'O Google recusou o formato do pedido nas duas APIs. Atualize o projeto (git pull) e, se continuar, abra um chamado com esta mensagem.',
  servico: 'Problema do lado do Google. Tente de novo em alguns minutos.',
  rede: 'Confira a internet deste computador e se algum firewall bloqueia generativelanguage.googleapis.com.',
};

/** Texto do resultado para o terminal (sem a chave). */
export function describeCheck(r: GeminiCheck): string[] {
  // Marcadores em ASCII: o Prompt de Comando do Windows nem sempre desenha símbolos.
  const lines = [`${r.ok ? '[OK]' : '[ERRO]'} ${r.message.replace(/[.\s]+$/, '')}.`];
  if (r.ok) {
    lines.push(`  API usada: ${r.api === 'generate-content' ? 'generateContent (anterior)' : 'Interactions (atual)'} · tokens neste teste: ${(r.inputTokens ?? 0) + (r.outputTokens ?? 0)}`);
  } else {
    if (r.models?.length) lines.push(`  Modelos de texto que esta chave enxerga: ${r.models.join(', ')}`);
    if (r.kind && HELP[r.kind]) lines.push(`  O que fazer: ${HELP[r.kind]}`);
  }
  return lines;
}

async function main(): Promise<number> {
  const c = loadConfig();
  const p = resolveLlmProvider({ ...c, llmProvider: 'gemini' });
  const i = process.argv.indexOf('--modelo');
  const model = (i > 0 ? normalizeGeminiModel(process.argv[i + 1]) : undefined) ?? c.geminiModel;
  console.log('');
  console.log('==================== CHAVE DO GEMINI ====================');
  if (!p.apiKey) {
    console.log(`[ERRO] ${p.reason}.`);
    console.log('  Rode o Configurar-Gemini.bat (ou: npm run gemini:setup) e cole a chave do Google AI Studio.');
    console.log('=========================================================');
    return 1;
  }
  console.log(` Chave: ${maskKey(p.apiKey)} · ${describeKeyKind(p.keyKind)}`);
  for (const n of p.notes) console.log(` Aviso: ${n}`);
  console.log(` Modelo: ${model}`);
  console.log(` LLM no painel: ${c.llmEnabled ? 'ligado (LLM_ENABLED=true)' : 'DESLIGADO (LLM_ENABLED=false): o teste abaixo funciona, mas o painel não usará o Gemini'}`);
  console.log(' Testando com o Google (uma geração mínima)…');
  const r = await checkGeminiKey(p.apiKey, model, { mode: c.geminiApiMode, thinkingLevel: c.geminiThinkingLevel });
  for (const l of describeCheck(r)) console.log(l);
  console.log('=========================================================');
  console.log('');
  return r.ok ? 0 : 1;
}

if (process.argv[1]?.endsWith('gemini-check.ts')) main().then((code) => process.exit(code));
