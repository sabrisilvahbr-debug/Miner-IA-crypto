#!/usr/bin/env node
// Minerador FALSO para os testes automatizados: só imprime linhas no formato das mensagens do SRBMiner-MULTI.
// Não minera, não abre rede, não lê arquivos. O modo vem de FAKE_SRB_MODE.
const mode = process.env.FAKE_SRB_MODE ?? 'ok';
const out = (s) => process.stdout.write(`${s}\n`);
out(`SRBMiner-MULTI (falso) args: ${process.argv.slice(2).join(' ')}`);
if (mode === 'crash') {
  setTimeout(() => { process.stderr.write('erro simulado de inicialização\n'); process.exit(3); }, 150);
} else if (mode === 'nohash') {
  setInterval(() => out('aguardando...'), 100);
} else {
  let n = 0;
  out('\u001b[32mpool: new job received\u001b[0m');
  setInterval(() => {
    n++;
    out(`GPU0 result accepted [${n}]`);
    if (n % 4 === 0) out('GPU0 result rejected');
    out(mode === 'weird' ? 'Total: muito rápido' : `[2026-11-01 09:00:0${n % 10}] Total: 25,10 TH/s`);
  }, 80);
}
process.on('SIGTERM', () => process.exit(0));
