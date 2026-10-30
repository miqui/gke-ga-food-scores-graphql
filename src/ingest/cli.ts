import { prisma } from '../prisma.js';
import { LivePortalClient } from './live-portal-client.js';
import { defaultSyncCounties, resolveCounties, UnknownCountyError } from './counties.js';
import { initSyncMetrics } from './metrics.js';
import { acquireSyncLock, orderCountiesForSync, runSync, SyncInProgressError, type SyncLock } from './run.js';

/**
 * Sync CLI: `node dist/ingest.js [COUNTY...]`. Counties come from argv, else
 * SYNC_COUNTIES, else all 159 (stalest first). Quote multi-word names:
 * `npm run sync -- "BEN HILL" LONG`. Exit code: 0 ok, 1 failed counties / lock
 * held / fatal error (failed counties listed on stderr), 130 interrupted.
 * Always flushes metrics before returning.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const metrics = initSyncMetrics();
  let exitCode = 0;
  let lock: SyncLock | undefined;
  try {
    const requested =
      argv.length > 0 ? resolveCounties(argv) : await orderCountiesForSync(prisma, defaultSyncCounties());

    try {
      lock = await acquireSyncLock(prisma, requested);
    } catch (err) {
      if (err instanceof SyncInProgressError) {
        console.error(`[sync] ${err.message}; not starting`);
        return 1;
      }
      throw err;
    }
    const held = lock;

    // First Ctrl-C / SIGTERM: finish the current facility, record the county as
    // interrupted (it resumes from its checkpoint next run) and exit. A second
    // one exits at once; that's still safe, since each facility is saved in a
    // single transaction.
    const stop = new AbortController();
    const onSignal = (sig: NodeJS.Signals) => {
      if (stop.signal.aborted) {
        console.error(`[sync] ${sig} again: exiting now`);
        void held.release().finally(() => process.exit(130));
        return;
      }
      console.log(`[sync] ${sig}: stopping after the current facility (send again to exit now)`);
      stop.abort(new Error(`stopped by ${sig}`));
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    const summary = await runSync(prisma, new LivePortalClient(), held, { signal: stop.signal });

    console.log(`[sync] finished: ${summary.ok.length}/${requested.length} counties ok`);
    if (summary.failed.length > 0) {
      console.error(`[sync] failed counties: ${summary.failed.join(', ')}`);
      exitCode = 1;
    }
    if (summary.interrupted) {
      console.log(`[sync] ${summary.interrupted} resumes from its checkpoint next run`);
      exitCode = 130;
    }
  } catch (err) {
    if (err instanceof UnknownCountyError) console.error(`[sync] ${err.message}`);
    else console.error('[sync] fatal error:', err);
    exitCode = 1;
  } finally {
    await metrics.flushAndShutdown(); // push metrics before the process exits
    await prisma.$disconnect();
  }
  return exitCode;
}
