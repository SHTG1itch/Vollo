import { closePool } from '../db/pool.js';
import { runStreakSweep, runTerritorySweep } from './sweeps.js';
import { scheduleWorkers } from './schedule.js';

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

  scheduleWorkers();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
