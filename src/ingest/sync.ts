import type { Prisma, PrismaClient } from '@prisma/client';
import type { PortalClient, PortalFacilityRecord, PortalInspectionRecord } from './portal-client.js';

export type Db = PrismaClient;

function stripLabel(value: string | undefined): string {
  if (!value) return '';
  const idx = value.indexOf(':');
  return idx === -1 ? value.trim() : value.slice(idx + 1).trim();
}

function parsePortalDate(value: string): string {
  const m = value.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return '';
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

/** ISO yyyy-mm-dd -> Date at UTC midnight (Postgres DATE column); '' / null -> null. */
export function toDate(iso: string | null | undefined): Date | null {
  return iso ? new Date(`${iso}T00:00:00Z`) : null;
}

/** Date from a DATE column -> ISO yyyy-mm-dd. */
export function toIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function parseFacilityRecord(county: string, raw: PortalFacilityRecord) {
  const columns = raw.columns ?? {};
  const addressLines = (raw.mapAddress ?? '').split('\n').map((l) => l.trim());
  const city = (() => {
    const last = addressLines[addressLines.length - 1] ?? '';
    const m = last.match(/^([A-Za-z .'-]+),?\s*GA/i);
    return m ? m[1].trim() : '';
  })();
  const lastScore = Number.parseInt(stripLabel(columns['4']), 10);
  return {
    portalId: raw.id,
    name: raw.name,
    address: raw.mapAddress ?? '',
    city,
    county,
    permitType: stripLabel(columns['2']),
    permitNumber: stripLabel(columns['3']),
    phone: stripLabel(columns['1']),
    lastInspectionScore: Number.isFinite(lastScore) ? lastScore : null,
    lastInspectionDate: parsePortalDate(stripLabel(columns['5'])) || null,
  };
}

/**
 * The portal's county search is a substring match and its records carry no
 * county field, so searching CLAY also returns every CLAYTON facility (the
 * only such overlap among GA county names). Clay County ZIPs all start with
 * 398 and Clayton's with 30, so drop CLAY results with a non-398 ZIP. Records
 * without a parseable ZIP are kept.
 */
function belongsToSearchedCounty(county: string, address: string): boolean {
  if (county !== 'CLAY') return true;
  const zip = address.match(/\bGA\s+(\d{5})/i)?.[1];
  return !zip || zip.startsWith('398');
}

export interface SyncResult {
  county: string;
  pagesWalked: number;
  facilitiesSeen: number;
  facilitiesSkipped: number;
  facilitiesUpserted: number;
  facilitiesWithNewInspections: number;
  inspectionsUpserted: number;
  violationsUpserted: number;
  /** Pending facilities from earlier runs that this run re-fetched outside the walk. */
  historiesRetried: number;
  /** Facilities in this county whose history still lacks their latest inspection. */
  historiesPending: number;
  newWatermark: string | null;
}

/**
 * The portal can list a facility's new inspection before the inspection itself
 * is posted, so a history only counts as complete once it has an inspection on
 * or after the listed date. (The listing can also lag behind the history, so
 * this is not an exact-date match.)
 */
function historyIsComplete(lastInspectionDate: string | null, history: PortalInspectionRecord[]): boolean {
  return !lastInspectionDate || history.some((i) => i.date >= lastInspectionDate);
}

/** Upsert a facility's inspections and replace their violations. Returns row counts. */
async function saveHistory(tx: Prisma.TransactionClient, facilityId: number, history: PortalInspectionRecord[]) {
  let inspectionsUpserted = 0;
  let violationsUpserted = 0;
  for (const insp of history) {
    const fields = {
      inspectionDate: toDate(insp.date)!,
      purpose: insp.purpose,
      score: Number.isFinite(insp.score) ? insp.score : null,
      inspector: insp.inspector,
      reportUrl: insp.printablePath,
    };
    const row = await tx.inspection.upsert({
      where: { portalId: String(insp.inspectionId) },
      create: { portalId: String(insp.inspectionId), facilityId, ...fields },
      update: { facilityId, ...fields },
      select: { id: true },
    });
    inspectionsUpserted += 1;

    // Replace violations for this inspection to avoid duplicate accumulation on re-sync.
    await tx.violation.deleteMany({ where: { inspectionId: row.id } });
    if (insp.violations.length > 0) {
      await tx.violation.createMany({
        data: insp.violations.map((v) => ({
          inspectionId: row.id,
          code: v.code,
          ruleCitation: v.ruleCitation,
          points: v.points,
          correctedOnSite: v.correctedOnSite,
          repeat: v.repeat,
          notes: v.notes,
        })),
      });
      violationsUpserted += insp.violations.length;
    }
  }
  return { inspectionsUpserted, violationsUpserted };
}

/** A facility with a long history can take many round trips; don't let Prisma's 5s default abort it. */
const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 };

/** Hard safety stop for a runaway walk; FULTON is ~1700 pages, so this leaves lots of headroom. */
export const DEFAULT_MAX_PAGES = 10_000;

/**
 * How far behind the watermark an incremental walk keeps going. Inspections are
 * often posted days after their inspection date, which sorts them below the
 * watermark of a run that happened in between; walking this far back picks
 * them up. Facilities whose listing is unchanged cost only the search page.
 */
export const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * A resumed walk restarts this many pages before its checkpoint: facilities
 * that got a new inspection meanwhile move to page 1 and push the rest down,
 * so the pages just before the checkpoint now hold records not yet walked.
 */
const RESUME_OVERLAP_PAGES = 2;

function daysBefore(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Walk a single county's paginated search results newest-inspection-first,
 * upsert facility rows, and stop as soon as we see a page whose records are
 * all strictly older than the stored watermark minus lookbackDays (nothing
 * new left to find). The lookback catches inspections posted late; with a
 * lookback of 0, records dated on the watermark day itself still don't stop
 * the walk, since more inspections for that day may have been posted after
 * the last sync.
 * After each page, the walk saves a checkpoint (next page, newest date so far)
 * in sync_state. A walk that fails, is aborted, or hits maxPages leaves the
 * watermark alone, and the next run resumes from the checkpoint (less
 * RESUME_OVERLAP_PAGES) instead of starting a large county over. Records that
 * changed on the pages skipped by a resume are newer than the checkpoint's
 * newest date, so the next incremental walk picks them up.
 * `signal` is checked between facilities, never inside one, so an abort
 * leaves every facility either fully saved or untouched.
 * Facilities whose last-inspection score/date changed (or are new, or still
 * pending) get their full inspection + violation history re-fetched. The fetch
 * happens before any write, and the facility row and its history are saved in
 * one transaction, so a failed fetch or a killed run never leaves a facility
 * marked current without its inspections.
 * After the walk, facilities still flagged history_pending that the walk didn't
 * reach (an incremental walk stops at the watermark) are re-fetched directly.
 */
export async function syncCounty(
  db: Db,
  client: PortalClient,
  county: string,
  options: { maxPages?: number; lookbackDays?: number; signal?: AbortSignal } = {},
): Promise<SyncResult> {
  const stateRow = await db.syncState.findUnique({ where: { county } });
  const watermark = toIso(stateRow?.watermark);
  const stopBefore = watermark ? daysBefore(watermark, options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) : null;

  const resumeFrom = stateRow?.resumePage ?? null;
  let page = resumeFrom ? Math.max(1, resumeFrom - RESUME_OVERLAP_PAGES) : 1;
  let pagesWalked = 0;
  let facilitiesSeen = 0;
  let facilitiesSkipped = 0;
  let facilitiesUpserted = 0;
  let facilitiesWithNewInspections = 0;
  let inspectionsUpserted = 0;
  let violationsUpserted = 0;
  let historiesRetried = 0;
  const fetchedThisRun = new Set<string>();
  let newestDateSeen: string | null = resumeFrom ? toIso(stateRow?.resumeNewest) : null;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  let reachedEnd = false;

  while (page <= maxPages) {
    options.signal?.throwIfAborted();
    const records = await client.searchCounty(county, page);
    if (records.length === 0) {
      reachedEnd = true;
      break;
    }
    pagesWalked += 1;

    let allBelowWatermark = true;

    for (const raw of records) {
      options.signal?.throwIfAborted();
      facilitiesSeen += 1;
      const parsed = parseFacilityRecord(county, raw);

      // Skipped records still count toward the stop check: results are sorted by
      // date across both counties, so a page of new foreign records can sit in
      // front of new records that do belong to this county.
      const belowWatermark =
        !!stopBefore && !!parsed.lastInspectionDate && parsed.lastInspectionDate < stopBefore;
      if (!belowWatermark) {
        allBelowWatermark = false;
      }

      if (!belongsToSearchedCounty(county, parsed.address)) {
        facilitiesSkipped += 1;
        continue;
      }

      if (!newestDateSeen || (parsed.lastInspectionDate && parsed.lastInspectionDate > newestDateSeen)) {
        newestDateSeen = parsed.lastInspectionDate || newestDateSeen;
      }

      const existing = await db.facility.findUnique({ where: { portalId: parsed.portalId } });
      const needsHistory =
        !existing ||
        existing.historyPending ||
        existing.lastInspectionScore !== parsed.lastInspectionScore ||
        toIso(existing.lastInspectionDate) !== parsed.lastInspectionDate;

      // Fetch before writing anything: if this throws, the facility row is left as
      // it was, so the next run still sees the change and fetches again.
      const history = needsHistory ? await client.getInspections(parsed.portalId) : [];
      if (needsHistory) fetchedThisRun.add(parsed.portalId);
      const row = {
        ...parsed,
        lastInspectionDate: toDate(parsed.lastInspectionDate),
        historyPending: needsHistory && !historyIsComplete(parsed.lastInspectionDate, history),
        updatedAt: new Date(),
      };

      const saved = await db.$transaction(async (tx) => {
        const fac = await tx.facility.upsert({
          where: { portalId: parsed.portalId },
          create: row,
          update: row,
          select: { id: true },
        });
        return saveHistory(tx, fac.id, history);
      }, TX_OPTIONS);
      facilitiesUpserted += 1;
      if (needsHistory) facilitiesWithNewInspections += 1;
      inspectionsUpserted += saved.inspectionsUpserted;
      violationsUpserted += saved.violationsUpserted;
    }

    if (stopBefore && allBelowWatermark) {
      reachedEnd = true;
      break;
    }
    page += 1;
    const checkpoint = { resumePage: page, resumeNewest: toDate(newestDateSeen) };
    await db.syncState.upsert({ where: { county }, create: { county, ...checkpoint }, update: checkpoint });
  }

  if (!reachedEnd) {
    throw new Error(
      `sync county=${county} hit maxPages=${maxPages} before the end of results; watermark not advanced, next run resumes at page ${page}`,
    );
  }

  const newWatermark = newestDateSeen ?? watermark;
  const finished = {
    watermark: toDate(newWatermark),
    lastSyncedAt: new Date(),
    resumePage: null,
    resumeNewest: null,
  };
  await db.syncState.upsert({ where: { county }, create: { county, ...finished }, update: finished });

  // Runs after the watermark is saved, so a failed retry doesn't undo the walk.
  const pendingRows = await db.facility.findMany({
    where: { county, historyPending: true },
    select: { id: true, portalId: true, lastInspectionDate: true },
  });
  for (const f of pendingRows.filter((r) => !fetchedThisRun.has(r.portalId))) {
    options.signal?.throwIfAborted();
    let history: PortalInspectionRecord[];
    try {
      history = await client.getInspections(f.portalId);
    } catch (err) {
      console.error(`[sync] county=${county} facility=${f.portalId} history retry failed:`, err);
      continue;
    }
    const saved = await db.$transaction(async (tx) => {
      await tx.facility.update({
        where: { id: f.id },
        data: { historyPending: !historyIsComplete(toIso(f.lastInspectionDate), history) },
      });
      return saveHistory(tx, f.id, history);
    }, TX_OPTIONS);
    historiesRetried += 1;
    inspectionsUpserted += saved.inspectionsUpserted;
    violationsUpserted += saved.violationsUpserted;
  }

  const historiesPending = await db.facility.count({ where: { county, historyPending: true } });

  return {
    county,
    pagesWalked,
    facilitiesSeen,
    facilitiesSkipped,
    facilitiesUpserted,
    facilitiesWithNewInspections,
    inspectionsUpserted,
    violationsUpserted,
    historiesRetried,
    historiesPending,
    newWatermark,
  };
}
