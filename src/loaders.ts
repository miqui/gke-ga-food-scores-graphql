import DataLoader from 'dataloader';
import { Prisma, type Facility, type Inspection, type PrismaClient, type Violation } from '@prisma/client';
import type { InspectionCursor } from './pagination.js';

export type InspectionRow = Inspection;
export type ViolationRow = Violation & { inspectionPortalId: string };

/**
 * Per-request DataLoaders. Everything the nested resolvers need is batched into one query per
 * (field, level), so a page of 100 facilities with inspections + violations is a fixed number
 * of SQL statements instead of 1 + N + N*M.
 */
export class Loaders {
  readonly facilityById: DataLoader<number, Facility | undefined>;
  readonly inspectionCountByFacility: DataLoader<number, number>;
  readonly violationsByInspection: DataLoader<number, Violation[]>;
  private readonly pages = new Map<string, DataLoader<number, InspectionRow[]>>();

  constructor(private readonly db: PrismaClient) {
    this.facilityById = new DataLoader(async (ids) => {
      const rows = await db.facility.findMany({ where: { id: { in: [...ids] } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => byId.get(id));
    });

    this.inspectionCountByFacility = new DataLoader(async (ids) => {
      const rows = await db.inspection.groupBy({
        by: ['facilityId'],
        where: { facilityId: { in: [...ids] } },
        _count: { _all: true },
      });
      const byId = new Map(rows.map((r) => [r.facilityId, r._count._all]));
      return ids.map((id) => byId.get(id) ?? 0);
    });

    this.violationsByInspection = new DataLoader(async (ids) => {
      const rows = await db.violation.findMany({
        where: { inspectionId: { in: [...ids] } },
        orderBy: [{ points: 'desc' }, { id: 'asc' }],
      });
      const grouped = new Map<number, Violation[]>();
      for (const r of rows) {
        const list = grouped.get(r.inspectionId);
        if (list) list.push(r);
        else grouped.set(r.inspectionId, [r]);
      }
      return ids.map((id) => grouped.get(id) ?? []);
    });
  }

  /**
   * Up to `take` newest inspections (after the cursor) for each facility, one query per batch.
   * A separate loader per distinct (take, cursor) pair because the window bounds differ.
   */
  inspectionsPage(take: number, after: InspectionCursor | undefined): DataLoader<number, InspectionRow[]> {
    const key = `${take}|${after ? `${after.d}:${after.id}` : ''}`;
    let loader = this.pages.get(key);
    if (!loader) {
      loader = new DataLoader(async (facilityIds) => {
        const cursorSql = after
          ? Prisma.sql`AND (inspection_date < ${after.d}::date OR (inspection_date = ${after.d}::date AND id < ${after.id}))`
          : Prisma.empty;
        const rows = await this.db.$queryRaw<InspectionRow[]>(Prisma.sql`
          SELECT id, portal_id AS "portalId", facility_id AS "facilityId",
                 inspection_date AS "inspectionDate", purpose, score, inspector,
                 report_url AS "reportUrl"
          FROM (
            SELECT i.*, row_number() OVER (
                     PARTITION BY facility_id ORDER BY inspection_date DESC, id DESC) AS rn
            FROM inspections i
            WHERE facility_id IN (${Prisma.join([...facilityIds])}) ${cursorSql}
          ) t
          WHERE rn <= ${take}
          ORDER BY facility_id, rn`);
        const grouped = new Map<number, InspectionRow[]>();
        for (const r of rows) {
          const list = grouped.get(r.facilityId);
          if (list) list.push(r);
          else grouped.set(r.facilityId, [r]);
        }
        return facilityIds.map((id) => grouped.get(id) ?? []);
      });
      this.pages.set(key, loader);
    }
    return loader;
  }
}

export interface Context {
  prisma: PrismaClient;
  loaders: Loaders;
}

export function createContext(prisma: PrismaClient): Context {
  return { prisma, loaders: new Loaders(prisma) };
}
