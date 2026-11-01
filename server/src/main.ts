// Ponto de entrada: node --experimental-strip-types server/src/main.ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { createApiServer } from './api/server.ts';

const config = loadConfig();
const app = createApp(config);
const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const server = createApiServer(app, webDir);

server.listen(config.port, config.host, () => {
  app.logger.log('info', 'AI CRYPTO MINER — VIRTUAL MINING OFFICE 50 em execução', {
    url: `http://${config.host}:${config.port}`,
    fontes: { mercado: config.marketSource, rede: config.networkSource, minerador: config.minerType, pool: config.poolSource, carteira: config.walletSource },
  });
  if (config.autostart) app.runtime.start();
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.logger.log('info', 'encerrando', { signal });
  setTimeout(() => process.exit(0), 8000).unref();
  // Nunca deixar o minerador rodando sem o painel: no Windows ele não morre junto com este processo.
  try { await app.runner?.stop(`servidor encerrado (${signal})`); } catch { app.supervisor?.killNow(); }
  app.runtime.stop();
  server.close(() => {
    app.store.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGHUP', () => void shutdown('SIGHUP')); // Windows: janela do console fechada
if (process.platform === 'win32') process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
process.on('exit', () => app.supervisor?.killNow());
