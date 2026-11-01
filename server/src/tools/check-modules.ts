// Verificação sem dependências (substitui parcialmente o "tsc" quando o npm não está disponível):
// importa todos os módulos do servidor para garantir que carregam sem erro de sintaxe ou de importação.
// Não substitui a checagem de tipos: rode "npm run typecheck" quando o TypeScript estiver instalado.
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP = new Set(['main.ts', 'luxor-check.ts', 'agents-audit.ts', 'check-modules.ts']); // têm efeitos ao carregar
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !SKIP.has(f) ? [p] : [];
  });
}
const files = walk(resolve('server/src'));
let fail = 0;
for (const f of files) {
  try {
    await import(pathToFileURL(f).href);
  } catch (e) {
    fail++;
    console.error(`✗ ${f}: ${(e as Error).message}`);
  }
}
console.log(`${files.length - fail}/${files.length} módulos carregados`);
process.exit(fail ? 1 : 0);
