import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  acquireSyncLock,
  currentSyncLock,
  LOCK_STALE_MS,
  orderCountiesForSync,
  recentSyncRuns,
  runSync,
  SyncInProgressError,
} from '../../src/ingest/run.js';
import type { PortalClient } from '../../src/ingest/portal-client.js';
import { hasDb, resetDb, testDb } from '../db.js';

const db = testDb();

describe.skipIf(!hasDb)('sync lock', () => {
  beforeEach(() => resetDb(db));
  afterAll(() => db.$disconnect());

  it('refuses a second holder until the first releases', async () => {
    const first = await acquireSyncLock(db, ['LONG']);
    await expect(acquireSyncLock(db, ['BRYAN'])).rejects.toThrow(SyncInProgressError);
    expect((await currentSyncLock(db))?.counties).toEqual(['LONG']);

    await first.release();
    expect(await currentSyncLock(db)).toBeNull();
    await expect((await acquireSyncLock(db, ['BRYAN'])).release()).resolves.toBeUndefined();
  });

  it('lets exactly one of several concurrent acquirers win', async () => {
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => acquireSyncLock(db, ['LONG'])));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(SyncInProgressError);
  });

  it('takes over a stale lock and marks its unfinished runs interrupted', async () => {
    const dead = await acquireSyncLock(db, ['LONG']);
    await db.syncRun.create({ data: { county: 'LONG', owner: dead.owner, startedAt: new Date(), status: 'running' } });
    await db.syncLock.updateMany({ data: { heartbeatAt: new Date(Date.now() - LOCK_STALE_MS - 1000) } });

    const lock = await acquireSyncLock(db, ['BRYAN']);
    expect((await db.syncRun.findFirst())?.status).toBe('interrupted');
    // The dead process can no longer heartbeat or release the new holder's lock.
    expect(await dead.heartbeat()).toBe(false);
    await dead.release();
    expect((await currentSyncLock(db))?.owner).toBe(lock.owner);
  });
});

describe.skipIf(!hasDb)('runSync', () => {
  beforeEach(() => resetDb(db));

  it('records each county, keeps going after a failure, and releases the lock', async () => {
    const client: PortalClient = {
      searchCounty: async (county) => {
        if (county === 'BRYAN') throw new Error('portal down');
        return [];
      },
      getInspections: async () => [],
    };
    const summary = await runSync(db, client, await acquireSyncLock(db, ['BRYAN', 'LONG']));

    expect(summary).toEqual({ ok: ['LONG'], failed: ['BRYAN'], interrupted: null });
    const runs = await recentSyncRuns(db);
    expect(runs.map((r) => [r.county, r.status])).toEqual([
      ['LONG', 'ok'],
      ['BRYAN', 'failed'],
    ]);
    expect(runs[1].error).toBe('portal down');
    expect(runs[0].result).toMatchObject({ county: 'LONG', pagesWalked: 0 });
    expect(await currentSyncLock(db)).toBeNull();
  });

  it('stops at the current county when aborted and records it as interrupted', async () => {
    const stop = new AbortController();
    const facility = {
      id: 'QQ==',
      name: 'A',
      mapAddress: '1 MAIN ST\r\nPEMBROKE, GA 31321',
      columns: { '5': 'Last Inspection Date: 10-01-2026' },
    };
    const client: PortalClient = {
      searchCounty: async () => {
        stop.abort(new Error('stopped by SIGTERM'));
        return [facility];
      },
      getInspections: async () => [],
    };
    const summary = await runSync(db, client, await acquireSyncLock(db, ['BRYAN', 'LONG']), { signal: stop.signal });

    expect(summary).toEqual({ ok: [], failed: [], interrupted: 'BRYAN' });
    const runs = await recentSyncRuns(db);
    expect(runs.map((r) => [r.county, r.status, r.error])).toEqual([['BRYAN', 'interrupted', 'stopped by SIGTERM']]);
    expect(await currentSyncLock(db)).toBeNull();
  });
});

describe.skipIf(!hasDb)('orderCountiesForSync', () => {
  beforeEach(() => resetDb(db));

  it('puts never-synced and unfinished counties first, then the oldest', async () => {
    await db.syncState.createMany({
      data: [
        { county: 'APPLING', lastSyncedAt: new Date('2026-10-27T10:00:00Z') },
        { county: 'BACON', lastSyncedAt: new Date('2026-10-20T10:00:00Z') },
        { county: 'BAKER', lastSyncedAt: new Date('2026-10-28T10:00:00Z'), resumePage: 4 },
      ],
    });
    expect(await orderCountiesForSync(db, ['APPLING', 'ATKINSON', 'BACON', 'BAKER'])).toEqual([
      'ATKINSON',
      'BAKER',
      'BACON',
      'APPLING',
    ]);
  });
});
