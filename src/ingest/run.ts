import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { PortalClient } from './portal-client.js';
import { syncCounty, toIso, type Db } from './sync.js';
import { recordCountySync } from './metrics.js';

/** A lock whose heartbeat is older than this belongs to a process that died. */
export const LOCK_STALE_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;
/** Serializes the check-then-take step of lock acquisition across processes (released at commit). */
const LOCK_ADVISORY_KEY = 727_001;

export interface SyncLockInfo {
  owner: string;
  counties: string[];
  acquiredAt: string;
  heartbeatAt: string;
}

export class SyncInProgressError extends Error {
  constructor(public readonly holder: SyncLockInfo) {
    super(`sync already in progress (owner ${holder.owner}, since ${holder.acquiredAt})`);
  }
}

export interface SyncLock {
  owner: string;
  counties: string[];
  /** Refresh the heartbeat; false if another process has taken the lock over. */
  heartbeat(): Promise<boolean>;
  release(): Promise<void>;
}

type LockRow = { owner: string; counties: Prisma.JsonValue; acquiredAt: Date; heartbeatAt: Date };

function toInfo(row: LockRow): SyncLockInfo {
  return {
    owner: row.owner,
    counties: row.counties as string[],
    acquiredAt: row.acquiredAt.toISOString(),
    heartbeatAt: row.heartbeatAt.toISOString(),
  };
}

function isLive(row: LockRow, now: number): boolean {
  return now - row.heartbeatAt.getTime() < LOCK_STALE_MS;
}

/** The lock of the sync running right now, from any process, or null. */
export async function currentSyncLock(db: Db): Promise<SyncLockInfo | null> {
  const row = await db.syncLock.findFirst();
  return row && isLive(row, Date.now()) ? toInfo(row) : null;
}

/**
 * Take the DB-wide sync lock, so the CLI and any other process never sync at
 * once: overlapping runs would multiply the portal request rate and race on the
 * same rows. The check-and-take runs under a Postgres transaction-level
 * advisory lock; the lock itself is a heartbeat row, so it survives pooled
 * connections. A lock left behind by a dead process goes stale after
 * LOCK_STALE_MS and is taken over. Throws SyncInProgressError if held.
 */
export async function acquireSyncLock(db: Db, counties: string[]): Promise<SyncLock> {
  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_ADVISORY_KEY})`;
    const row = await tx.syncLock.findUnique({ where: { id: 1 } });
    if (row && isLive(row, Date.now())) throw new SyncInProgressError(toInfo(row));
    const now = new Date();
    const lock = { owner, counties, acquiredAt: now, heartbeatAt: now };
    await tx.syncLock.upsert({ where: { id: 1 }, create: { id: 1, ...lock }, update: lock });
    // Holding the lock means no other run is live, so any run still marked
    // running was cut off (crash, kill -9) before it could record its end.
    await tx.syncRun.updateMany({
      where: { status: 'running' },
      data: { status: 'interrupted', finishedAt: now, error: 'process ended without finishing' },
    });
  });

  return {
    owner,
    counties,
    heartbeat: async () =>
      (await db.syncLock.updateMany({ where: { owner }, data: { heartbeatAt: new Date() } })).count === 1,
    release: async () => {
      await db.syncLock.deleteMany({ where: { owner } });
    },
  };
}

/**
 * Order counties for a sync of the default set: never-synced (or unfinished)
 * counties first, then by oldest last_synced_at. A run that's stopped early
 * then leaves the counties it didn't reach at the front of the next run,
 * instead of starting at APPLING every time.
 */
export async function orderCountiesForSync(db: Db, counties: string[]): Promise<string[]> {
  const rows = await db.syncState.findMany({ select: { county: true, lastSyncedAt: true, resumePage: true } });
  const lastSynced = new Map(rows.map((r) => [r.county, r.resumePage ? '' : (r.lastSyncedAt?.toISOString() ?? '')]));
  return [...counties].sort((a, b) => (lastSynced.get(a) ?? '').localeCompare(lastSynced.get(b) ?? ''));
}

export interface SyncRunSummary {
  ok: string[];
  failed: string[];
  /** The county being synced when the run was stopped, if it was. */
  interrupted: string | null;
}

/**
 * Sync each of the lock's counties in order, recording one sync_runs row per
 * county, and release the lock when done. One failing county doesn't stop
 * the rest. When `signal` aborts (or the lock is lost), the current county
 * stops between facilities, is recorded as interrupted, and the run ends.
 */
export async function runSync(
  db: Db,
  client: PortalClient,
  lock: SyncLock,
  options: { signal?: AbortSignal } = {},
): Promise<SyncRunSummary> {
  const lockLost = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lockLost.signal]) : lockLost.signal;
  const heartbeat = setInterval(() => {
    lock
      .heartbeat()
      .then((held) => {
        if (!held) lockLost.abort(new Error('sync lock was taken over by another process'));
      })
      .catch((err) => console.error('[sync] heartbeat failed:', err));
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const summary: SyncRunSummary = { ok: [], failed: [], interrupted: null };
  try {
    for (const county of lock.counties) {
      if (signal.aborted) break;
      const startedAtMs = Date.now();
      const run = await db.syncRun.create({
        data: { county, owner: lock.owner, startedAt: new Date(startedAtMs), status: 'running' },
        select: { id: true },
      });
      const finish = async (
        status: 'ok' | 'failed' | 'interrupted',
        fields: { result?: Prisma.InputJsonValue; error?: string },
        facilitiesUpserted = 0,
      ) => {
        await db.syncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), status, ...fields } });
        recordCountySync(county, status, (Date.now() - startedAtMs) / 1000, facilitiesUpserted);
      };

      console.log(`[sync] starting county=${county}`);
      try {
        const result = await syncCounty(db, client, county, { signal });
        await finish('ok', { result: result as unknown as Prisma.InputJsonValue }, result.facilitiesUpserted);
        console.log(`[sync] done county=${county}`, JSON.stringify(result));
        summary.ok.push(county);
      } catch (err) {
        if (signal.aborted) {
          await finish('interrupted', { error: errorMessage(signal.reason) });
          console.log(`[sync] stopped during county=${county}: ${errorMessage(signal.reason)}`);
          summary.interrupted = county;
          break;
        }
        await finish('failed', { error: errorMessage(err) });
        console.error(`[sync] county=${county} failed:`, err);
        summary.failed.push(county);
      }
    }
  } finally {
    clearInterval(heartbeat);
    await lock.release();
  }
  return summary;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The most recent sync_runs rows, newest first. */
export async function recentSyncRuns(db: Db, limit = 50) {
  const rows = await db.syncRun.findMany({ orderBy: { id: 'desc' }, take: limit });
  return rows.map((r) => ({ ...r, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null }));
}

export { toIso };
