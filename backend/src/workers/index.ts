import cron from 'node-cron';
import { closePool } from '../db/pool.js';
import { runStreakSweep, runTerritorySweep } from './sweeps.js';

/**
 * Decoupled worker process for the asynchronous, long-term telemetry the spec
 * describes. Run alongside the API (`npm run worker`) or as a separate Render
 * background worker. Pass `--once` to run both sweeps immediately and exit
 * (handy right after seeding).
 *
 *   npm run worker            # schedule the crons and stay alive
 *   npm run worker -- --once  # run once and exit
 */
async function runOnce(): Promise<void> {
  await runStreakSweep();
  await runTerritorySweep();
}

async function main(): Promise<void> {
  if (process.argv.includes('--once')) {
    await runOnce();
    await closePool();
    process.exit(0);
  }

  // Temporal heat index — daily at 03:00.
  cron.schedule('0 3 * * *', () => {
    void runStreakSweep().catch((e) => console.error('[worker] streak sweep failed', e));
  });

  // Territory recompute — every 6 hours.
  cron.schedule('0 */6 * * *', () => {
    void runTerritorySweep().catch((e) => console.error('[worker] territory sweep failed', e));
  });

  console.log('🛠️  Vollo worker scheduled (streak: daily 03:00, territory: every 6h)');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
