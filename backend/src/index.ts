import { createApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`🎾 Vollo API listening on http://localhost:${config.port} (${config.env})`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[server] received ${signal}, shutting down…`);
  server.close(() => {
    void closePool().finally(() => process.exit(0));
  });
  // Force-exit if connections hang.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
