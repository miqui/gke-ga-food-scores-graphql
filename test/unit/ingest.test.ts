import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { syncCounty } from '../../src/ingest/sync.js';
import { FixturePortalClient } from '../fixture-portal-client.js';
import { hasDb, resetDb, testDb } from '../db.js';
import type { PortalInspectionRecord } from '../../src/ingest/portal-client.js';

const page1 = JSON.parse(readFileSync(new URL('../fixtures/long-search-page1.json', import.meta.url), 'utf-8'));
const inspectionsFixture = JSON.parse(
  readFileSync(new URL('../fixtures/long-inspections-MTI5Nzg5Mzc.json', import.meta.url), 'utf-8'),
) as any[];

function toInspectionRecord(raw: any): PortalInspectionRecord {
  const stripLabel = (v: string) => v.slice(v.indexOf(':') + 1).trim();
  const violationsRaw = raw.violations ?? {};
  return {
    inspectionId: raw.inspectionId,
    facilityId: raw.facilityId,
    printablePath: raw.printablePath,
    date: (() => {
      const m = stripLabel(raw.columns['0']).match(/(\d{2})-(\d{2})-(\d{4})/);
      return m ? `${m[3]}-${m[1]}-${m[2]}` : '';
    })(),
    purpose: stripLabel(raw.columns['1']),
    score: Number.parseInt(stripLabel(raw.columns['2']), 10),
    inspector: stripLabel(raw.columns['3']),
    violations: Object.values(violationsRaw).map((v: any) => ({
      code: v[0],
      ruleCitation: v[1],
      points: Number.parseInt(stripLabel(v[2]), 10),
      correctedOnSite: stripLabel(v[3]).toLowerCase() === 'yes',
      repeat: stripLabel(v[4]).toLowerCase() === 'yes',
      notes: stripLabel(v[5]),
    })),
  };
}

const db = testDb();
const iso = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;
const setState = (county: string, watermark: string) =>
  db.syncState.upsert({
    where: { county },
    create: { county, watermark: new Date(`${watermark}T00:00:00Z`), lastSyncedAt: new Date() },
    update: { watermark: new Date(`${watermark}T00:00:00Z`) },
  });
const facilityIds = async () => (await db.facility.findMany({ orderBy: { id: 'asc' } })).map((f) => f.portalId);

describe.skipIf(!hasDb)('ingest walker against fixtures (Postgres, no network)', () => {
  beforeEach(() => resetDb(db));
  afterAll(() => db.$disconnect());

  it('upserts facilities from a county search page and fetches inspection history for new facilities', async () => {
    const client = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: page1, 2: [] } },
      inspectionsByFacility: { 'MTI5Nzg5Mzc=': inspectionsFixture.map(toInspectionRecord) },
    });

    const result = await syncCounty(db, client, 'LONG');

    expect(result.facilitiesSeen).toBe(page1.length);
    expect(result.pagesWalked).toBe(1); // page 2 is empty -> walker stops
    expect(result.newWatermark).toBe('2026-08-07');
    expect(await db.facility.count({ where: { county: 'LONG' } })).toBe(page1.length);

    const fac = await db.facility.findUnique({
      where: { portalId: 'MTI5Nzg5Mzc=' },
      include: { inspections: { include: { violations: true } } },
    });
    expect(fac?.name).toContain('Louis Shaved Ice');
    expect(fac?.inspections.length).toBe(inspectionsFixture.length);
    expect(fac?.inspections.flatMap((i) => i.violations).length).toBe(result.violationsUpserted);

    const state = await db.syncState.findUnique({ where: { county: 'LONG' } });
    expect(iso(state?.watermark)).toBe('2026-08-07');
    expect(state?.resumePage).toBeNull();
  });

  it('is idempotent: re-syncing does not duplicate inspections or violations', async () => {
    const make = () =>
      new FixturePortalClient({
        pagesByCounty: { LONG: { 1: page1, 2: [] } },
        inspectionsByFacility: { 'MTI5Nzg5Mzc=': inspectionsFixture.map(toInspectionRecord) },
      });
    await syncCounty(db, make(), 'LONG');
    const before = [await db.inspection.count(), await db.violation.count(), await db.facility.count()];
    const second = make();
    await syncCounty(db, second, 'LONG');
    expect([await db.inspection.count(), await db.violation.count(), await db.facility.count()]).toEqual(before);
    expect(second.inspectionCalls).not.toContain('MTI5Nzg5Mzc='); // unchanged, complete listings are not re-fetched
  });

  it('stops walking once a page is entirely below the stored watermark', async () => {
    await setState('LONG', '2026-08-08');
    const client = new FixturePortalClient({ pagesByCounty: { LONG: { 1: page1 } }, inspectionsByFacility: {} });

    const result = await syncCounty(db, client, 'LONG', { lookbackDays: 0 });

    expect(result.pagesWalked).toBe(1);
    expect(client.searchCalls.length).toBe(1);
  });

  it('keeps walking through the lookback window behind the watermark', async () => {
    await setState('LONG', '2026-08-08');
    const postedLate = { ...page1[0], id: 'TEFURQ==', columns: { ...page1[0].columns, '5': 'Last Inspection Date: 07-20-2026' } };
    const old = { ...page1[0], id: 'T0xE', columns: { ...page1[0].columns, '5': 'Last Inspection Date: 05-01-2026' } };
    const client = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: page1, 2: [postedLate], 3: [old], 4: [] } },
      inspectionsByFacility: {},
    });

    await syncCounty(db, client, 'LONG');

    expect(client.searchCalls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(await db.facility.findUnique({ where: { portalId: 'TEFURQ==' } })).not.toBeNull();
  });

  it('keeps walking past a page whose newest records fall on the watermark day', async () => {
    await setState('LONG', '2026-08-07');
    const sameDay = { ...page1[0], id: 'U0FNRURBWQ==', name: 'Posted later the same day' };
    const client = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: page1, 2: [sameDay], 3: [] } },
      inspectionsByFacility: {},
    });

    const result = await syncCounty(db, client, 'LONG');

    expect(client.searchCalls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(result.pagesWalked).toBe(2);
    expect(await db.facility.findUnique({ where: { portalId: 'U0FNRURBWQ==' } })).not.toBeNull();
  });

  it('throws without advancing the watermark when maxPages is hit before the end', async () => {
    const client = new FixturePortalClient({ pagesByCounty: { LONG: { 1: page1, 2: page1, 3: [] } }, inspectionsByFacility: {} });

    await expect(syncCounty(db, client, 'LONG', { maxPages: 1 })).rejects.toThrow(/maxPages=1/);
    const state = await db.syncState.findUnique({ where: { county: 'LONG' } });
    expect(state?.watermark).toBeNull();
    expect(state?.resumePage).toBe(2);
    expect(await db.facility.count()).toBe(page1.length); // facilities walked so far are kept
  });

  it('calls the client once per page/facility, serially (the live client enforces 1 req/s)', async () => {
    const client = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: page1, 2: [] } },
      inspectionsByFacility: { 'MTI5Nzg5Mzc=': inspectionsFixture.map(toInspectionRecord) },
    });
    await syncCounty(db, client, 'LONG');
    expect(client.searchCalls).toEqual([
      { county: 'LONG', page: 1 },
      { county: 'LONG', page: 2 },
    ]);
    expect(client.inspectionCalls.length).toBe(page1.length);
  });
});

describe.skipIf(!hasDb)('CLAY vs CLAYTON substring overlap', () => {
  beforeEach(() => resetDb(db));
  const record = (id: string, address: string, date: string) => ({
    ...page1[0],
    id,
    mapAddress: address,
    columns: { ...page1[0].columns, '5': `Last Inspection Date: ${date}` },
  });
  const clay = record('Q0xBWQ==', '105 S HANCOCK ST \r\nFORT GAINES, GA 39851', '09-09-2026');
  const clayton = record('Q0xBWVRPTg==', '1 MAIN ST \r\nJONESBORO, GA 30236', '10-20-2026');

  it('skips CLAYTON records and keeps them out of the CLAY watermark', async () => {
    const client = new FixturePortalClient({ pagesByCounty: { CLAY: { 1: [clayton, clay], 2: [] } }, inspectionsByFacility: {} });
    const result = await syncCounty(db, client, 'CLAY');

    expect(result.facilitiesSeen).toBe(2);
    expect(result.facilitiesSkipped).toBe(1);
    expect(result.newWatermark).toBe('2026-09-09');
    expect(await facilityIds()).toEqual([clay.id]);
    expect(client.inspectionCalls).toEqual([clay.id]);
  });

  it('does not relabel CLAYTON facilities when CLAY is synced after CLAYTON', async () => {
    const client = new FixturePortalClient({
      pagesByCounty: { CLAYTON: { 1: [clayton], 2: [] }, CLAY: { 1: [clayton, clay], 2: [] } },
      inspectionsByFacility: {},
    });
    await syncCounty(db, client, 'CLAYTON');
    await syncCounty(db, client, 'CLAY');
    expect((await db.facility.findUnique({ where: { portalId: clayton.id } }))?.county).toBe('CLAYTON');
  });

  it('keeps walking past a page of new CLAYTON-only records', async () => {
    await setState('CLAY', '2026-09-01');
    const client = new FixturePortalClient({ pagesByCounty: { CLAY: { 1: [clayton], 2: [clay], 3: [] } }, inspectionsByFacility: {} });
    const result = await syncCounty(db, client, 'CLAY');

    expect(client.searchCalls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(await db.facility.findUnique({ where: { portalId: clay.id } })).not.toBeNull();
    expect(result.newWatermark).toBe('2026-09-09');
  });
});

describe.skipIf(!hasDb)('inspection history integrity', () => {
  beforeEach(() => resetDb(db));
  const HID = 'SElTVE9SWQ==';
  const listing = (date: string, score: number) => ({
    ...page1[0],
    id: HID,
    columns: { ...page1[0].columns, '4': `Last Inspection Score: ${score}`, '5': `Last Inspection Date: ${date}` },
  });
  const inspection = (inspectionId: number, date: string): PortalInspectionRecord => ({
    inspectionId,
    facilityId: HID,
    printablePath: '',
    date,
    purpose: 'Routine',
    score: 90,
    inspector: 'Inspector',
    violations: [],
  });
  const facility = () => db.facility.findUnique({ where: { portalId: HID } });
  const inspectionCount = async () => db.inspection.count({ where: { facility: { portalId: HID } } });

  it('leaves the facility row unchanged when the history fetch fails, so the next run retries', async () => {
    const first = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [listing('08-01-2026', 90)], 2: [] } },
      inspectionsByFacility: { [HID]: [inspection(1, '2026-08-01')] },
    });
    await syncCounty(db, first, 'LONG');

    const failing = new FixturePortalClient({ pagesByCounty: { LONG: { 1: [listing('10-01-2026', 80)], 2: [] } }, inspectionsByFacility: {} });
    failing.getInspections = async () => {
      throw new Error('portal down');
    };
    await expect(syncCounty(db, failing, 'LONG')).rejects.toThrow('portal down');
    expect(iso((await facility())?.lastInspectionDate)).toBe('2026-08-01');
    expect((await facility())?.lastInspectionScore).toBe(90);

    const recovered = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [listing('10-01-2026', 80)], 2: [] } },
      inspectionsByFacility: { [HID]: [inspection(2, '2026-10-01'), inspection(1, '2026-08-01')] },
    });
    await syncCounty(db, recovered, 'LONG');
    expect(recovered.inspectionCalls).toEqual([HID]);
    expect(iso((await facility())?.lastInspectionDate)).toBe('2026-10-01');
    expect(await inspectionCount()).toBe(2);
  });

  it('does not store a new facility when its first history fetch fails', async () => {
    const failing = new FixturePortalClient({ pagesByCounty: { LONG: { 1: [listing('10-01-2026', 80)], 2: [] } }, inspectionsByFacility: {} });
    failing.getInspections = async () => {
      throw new Error('portal down');
    };
    await expect(syncCounty(db, failing, 'LONG')).rejects.toThrow('portal down');
    expect(await facility()).toBeNull();
  });

  it('rolls the whole facility back when saving its history fails midway (all-or-nothing)', async () => {
    const bad = { ...inspection(1, '2026-08-01'), violations: [{ code: 'X', ruleCitation: '', points: 1, correctedOnSite: false, repeat: false, notes: '\u0000' }] };
    const client = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [listing('08-01-2026', 90)], 2: [] } },
      inspectionsByFacility: { [HID]: [bad] },
    });
    await expect(syncCounty(db, client, 'LONG')).rejects.toThrow(); // NUL byte is invalid in Postgres text
    expect(await facility()).toBeNull();
    expect(await db.inspection.count()).toBe(0);
  });

  it('flags a history missing the listed inspection and retries it after the walk', async () => {
    const notYetPosted = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [listing('10-01-2026', 80)], 2: [] } },
      inspectionsByFacility: { [HID]: [inspection(1, '2026-08-01')] },
    });
    const first = await syncCounty(db, notYetPosted, 'LONG');
    expect(first.historiesPending).toBe(1);
    expect((await facility())?.historyPending).toBe(true);
    expect(iso((await facility())?.lastInspectionDate)).toBe('2026-10-01');

    const newer = { ...listing('10-20-2026', 95), id: 'TkVXRVI=' };
    const older = { ...listing('01-01-2026', 95), id: 'T0xERVI=' };
    const posted = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [newer], 2: [older], 3: [] } },
      inspectionsByFacility: { [HID]: [inspection(2, '2026-10-01'), inspection(1, '2026-08-01')] },
    });
    await db.syncState.update({ where: { county: 'LONG' }, data: { watermark: new Date('2026-10-15T00:00:00Z') } });
    const second = await syncCounty(db, posted, 'LONG');

    expect(posted.searchCalls.map((c) => c.page)).toEqual([1, 2]);
    expect(posted.inspectionCalls).toContain(HID);
    expect(second.historiesRetried).toBeGreaterThanOrEqual(1);
    expect((await facility())?.historyPending).toBe(false);
    expect(await inspectionCount()).toBe(2);
  });

  it('continues after a pending history fetch fails and retries that facility on the next sync', async () => {
    const secondId = 'UkVUUlk=';
    const initial = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [listing('10-01-2026', 80), { ...listing('10-01-2026', 90), id: secondId }] } },
      inspectionsByFacility: { [HID]: [inspection(1, '2026-08-01')] },
    });
    await syncCounty(db, initial, 'LONG');
    const beforeFailure = await facility();

    const retry = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [] } },
      inspectionsByFacility: { [secondId]: [{ ...inspection(2, '2026-10-01'), facilityId: secondId }] },
    });
    const error = new Error('portal down');
    const fetch = vi.spyOn(retry, 'getInspections').mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await syncCounty(db, retry, 'LONG');

      expect(fetch.mock.calls).toEqual([[HID], [secondId]]);
      expect(log).toHaveBeenCalledExactlyOnceWith(`[sync] county=LONG facility=${HID} history retry failed:`, error);
      expect(result.historiesPending).toBe(1);
      expect(result.historiesRetried).toBe(1);
      expect(result.inspectionsUpserted).toBe(1);
      expect(await facility()).toEqual(beforeFailure);
      expect(await inspectionCount()).toBe(1);
      expect((await db.facility.findUnique({ where: { portalId: secondId } }))?.historyPending).toBe(false);

      const recovered = new FixturePortalClient({
        pagesByCounty: { LONG: { 1: [] } },
        inspectionsByFacility: { [HID]: [inspection(3, '2026-10-01'), inspection(1, '2026-08-01')] },
      });
      const next = await syncCounty(db, recovered, 'LONG');

      expect(recovered.inspectionCalls).toEqual([HID]);
      expect(next.historiesRetried).toBe(1);
      expect(next.historiesPending).toBe(0);
      expect((await facility())?.historyPending).toBe(false);
      expect(await inspectionCount()).toBe(2);
    } finally {
      log.mockRestore();
      fetch.mockRestore();
    }
  });

  it('accepts a history whose newest inspection is later than the listed date', async () => {
    const client = new FixturePortalClient({
      pagesByCounty: { LONG: { 1: [listing('03-12-2026', 88)], 2: [] } },
      inspectionsByFacility: { [HID]: [inspection(2, '2026-09-11'), inspection(1, '2026-03-01')] },
    });
    await syncCounty(db, client, 'LONG');
    expect((await facility())?.historyPending).toBe(false);
  });
});

describe.skipIf(!hasDb)('resuming and stopping a walk', () => {
  beforeEach(() => resetDb(db));
  // One facility per page, newest first: page n is dated 10-(20-n)-2026.
  const pageRecord = (n: number) => ({
    ...page1[0],
    id: `UEFHRS${n}`,
    columns: { ...page1[0].columns, '5': `Last Inspection Date: 10-${String(20 - n).padStart(2, '0')}-2026` },
  });
  const pages = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, [pageRecord(n)]]));

  it('resumes an interrupted first walk near its checkpoint and keeps its newest date', async () => {
    const failing = new FixturePortalClient({ pagesByCounty: { LONG: { ...pages, 7: [] } }, inspectionsByFacility: {} });
    const search = failing.searchCounty.bind(failing);
    failing.searchCounty = async (county, page) => {
      if (page === 6) throw new Error('portal down');
      return search(county, page);
    };
    await expect(syncCounty(db, failing, 'LONG')).rejects.toThrow('portal down');
    const checkpoint = await db.syncState.findUnique({ where: { county: 'LONG' } });
    expect(checkpoint?.watermark).toBeNull();
    expect(checkpoint?.resumePage).toBe(6);
    expect(iso(checkpoint?.resumeNewest)).toBe('2026-10-19');

    const client = new FixturePortalClient({ pagesByCounty: { LONG: { ...pages, 7: [] } }, inspectionsByFacility: {} });
    const result = await syncCounty(db, client, 'LONG');

    expect(client.searchCalls.map((c) => c.page)).toEqual([4, 5, 6, 7]); // restarts 2 pages before the checkpoint
    expect(result.newWatermark).toBe('2026-10-19');
    const done = await db.syncState.findUnique({ where: { county: 'LONG' } });
    expect(iso(done?.watermark)).toBe('2026-10-19');
    expect(done?.resumePage).toBeNull();
    expect(done?.resumeNewest).toBeNull();
  });

  it('stops between facilities when aborted, keeping the facilities already saved', async () => {
    const stop = new AbortController();
    const client = new FixturePortalClient({ pagesByCounty: { LONG: { 1: page1, 2: [] } }, inspectionsByFacility: {} });
    const getInspections = client.getInspections.bind(client);
    client.getInspections = async (id) => {
      const history = await getInspections(id);
      stop.abort(new Error('stopped by SIGINT'));
      return history;
    };

    await expect(syncCounty(db, client, 'LONG', { signal: stop.signal })).rejects.toThrow('stopped by SIGINT');
    expect(await facilityIds()).toEqual([page1[0].id]);
    expect((await db.syncState.findUnique({ where: { county: 'LONG' } }))?.watermark ?? null).toBeNull();
  });
});
