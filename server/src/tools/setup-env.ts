// Prepara o .env para uso no próprio computador: npm run setup (chamado pelo Iniciar-Painel.bat).
// - Sem .env: copia o .env.example (HOST=127.0.0.1, sem token, fontes públicas reais, mineração desativada).
// - Com .env aberto à rede (HOST=0.0.0.0) e sem API_TOKEN: volta para 127.0.0.1, porque assim
//   o painel recusaria até o próprio computador. Nunca lê, mostra ou gera segredos.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export function fixEnv(text: string): { text: string; changes: string[] } {
  const changes: string[] = [];
  const hasToken = /^API_TOKEN=[ \t]*[^\s#]/m.test(text);
  let out = text;
  if (!hasToken && /^HOST=[ \t]*0\.0\.0\.0/m.test(out)) {
    out = out.replace(/^HOST=[ \t]*0\.0\.0\.0.*$/m, 'HOST=127.0.0.1            # só este computador (0.0.0.0 exige API_TOKEN)');
    changes.push('HOST trocado de 0.0.0.0 para 127.0.0.1 (não havia API_TOKEN)');
  }
  return { text: out, changes };
}

function main(dir: string) {
  const env = `${dir}/.env`;
  if (!existsSync(env)) {
    copyFileSync(`${dir}/.env.example`, env);
    console.log('Configuração criada: .env (uso local, sem token, mineração DESATIVADA).');
    return;
  }
  const { text, changes } = fixEnv(readFileSync(env, 'utf8'));
  if (changes.length) {
    writeFileSync(env, text);
    for (const c of changes) console.log(`Ajuste no .env: ${c}.`);
  } else {
    console.log('Configuração .env encontrada.');
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('setup-env.ts')) main(process.cwd());
