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

function shutdown(signal: string) {
  app.logger.log('info', 'encerrando', { signal });
  app.runtime.stop();
  server.close(() => {
    app.store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
