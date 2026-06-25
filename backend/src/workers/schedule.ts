import cron from 'node-cron';
import { runStreakSweep, runTerritorySweep } from './sweeps.js';

/**
 * Register the recurring telemetry sweeps. Shared by the standalone worker
 * process and the API server (when START_WORKER=true) so a single free-tier
 * web service can host everything at $0.
 */
export function scheduleWorkers(): void {
  // Temporal heat index — daily at 03:00.
  cron.schedule('0 3 * * *', () => {
    void runStreakSweep().catch((e) => console.error('[worker] streak sweep failed', e));
  });

  // Territory recompute — every 6 hours.
  cron.schedule('0 */6 * * *', () => {
    void runTerritorySweep().catch((e) => console.error('[worker] territory sweep failed', e));
  });

  console.log('🛠️  Vollo sweeps scheduled (streak: daily 03:00, territory: every 6h)');
}
