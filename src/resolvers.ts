import { GraphQLScalarType, Kind, type GraphQLFieldResolver } from 'graphql';
import type { Facility, Inspection, Prisma, SyncRun, Violation } from '@prisma/client';
import type { Context } from './loaders.js';
import { GA_COUNTIES } from './ingest/counties.js';
import {
  badInput,
  decodeFacilityCursor,
  decodeInspectionCursor,
  encodeCursor,
  pageSize,
  toDateOnly,
} from './pagination.js';
import { MAX_SYNC_RUNS } from './schema.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown): Date {
  if (typeof value === 'string' && DATE_RE.test(value)) {
    const d = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime()) && toDateOnly(d) === value) return d;
  }
  throw new TypeError('Date must be a valid YYYY-MM-DD string');
}

const DateScalar = new GraphQLScalarType({
  name: 'Date',
  description: 'Calendar date, serialized as YYYY-MM-DD (no time zone).',
  serialize: (value) => {
    if (value instanceof Date) return toDateOnly(value);
    if (typeof value === 'string' && DATE_RE.test(value)) return value;
    throw new TypeError('Date cannot represent a non-date value');
  },
  parseValue: parseDate,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING) throw new TypeError('Date must be a string');
    return parseDate(ast.value);
  },
});

const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  description: 'Instant in time, serialized as an ISO 8601 UTC string.',
  serialize: (value) => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
    throw new TypeError('DateTime cannot represent a non-date value');
  },
  parseValue: (value) => {
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value);
    throw new TypeError('DateTime must be an ISO 8601 string');
  },
  parseLiteral: (ast) => {
    if (ast.kind === Kind.STRING && !Number.isNaN(Date.parse(ast.value))) return new Date(ast.value);
    throw new TypeError('DateTime must be an ISO 8601 string');
  },
});

const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value.',
  serialize: (v) => v,
  parseValue: (v) => v,
});

const MAX_Q_LENGTH = 100;
const SORT_FACILITIES = [{ lastInspectionDate: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }] as const;

interface FacilitiesArgs {
  county?: string | null;
  city?: string | null;
  minScore?: number | null;
  q?: string | null;
  first?: number | null;
  after?: string | null;
}

function facilityFilter(args: FacilitiesArgs): Prisma.FacilityWhereInput {
  const and: Prisma.FacilityWhereInput[] = [];
  const county = args.county?.trim();
  if (county) and.push({ county: county.toUpperCase() });
  const city = args.city?.trim();
  if (city) and.push({ city: { equals: city, mode: 'insensitive' } });
  if (args.minScore != null) {
    if (!Number.isInteger(args.minScore) || args.minScore < 0 || args.minScore > 100) {
      throw badInput('minScore must be an integer between 0 and 100');
    }
    and.push({ lastInspectionScore: { gte: args.minScore } });
  }
  const q = args.q?.trim();
  if (q) {
    if (q.length > MAX_Q_LENGTH) throw badInput(`q must be at most ${MAX_Q_LENGTH} characters`);
    and.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { address: { contains: q, mode: 'insensitive' } },
        { city: { contains: q, mode: 'insensitive' } },
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
}

function afterFacility(cursor: string | null | undefined): Prisma.FacilityWhereInput | undefined {
  if (!cursor) return undefined;
  const c = decodeFacilityCursor(cursor);
  if (c.d === null) return { lastInspectionDate: null, id: { gt: c.id } };
  const d = new Date(`${c.d}T00:00:00.000Z`);
  return { OR: [{ lastInspectionDate: { lt: d } }, { lastInspectionDate: d, id: { gt: c.id } }, { lastInspectionDate: null }] };
}

const facilityCursor = (f: Facility): string =>
  encodeCursor({ d: f.lastInspectionDate ? toDateOnly(f.lastInspectionDate) : null, id: f.id });
const inspectionCursor = (i: Inspection): string => encodeCursor({ d: toDateOnly(i.inspectionDate), id: i.id });

interface Connection<T> {
  edges: { cursor: string; node: T }[];
  nodes: T[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: () => Promise<number>;
}

function connection<T>(rows: T[], first: number, cursorOf: (r: T) => string, totalCount: () => Promise<number>): Connection<T> {
  const hasNextPage = rows.length > first;
  const nodes = hasNextPage ? rows.slice(0, first) : rows;
  const edges = nodes.map((node) => ({ cursor: cursorOf(node), node }));
  return {
    edges,
    nodes,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
    totalCount,
  };
}

function limitArg(limit: number | null | undefined, fallback: number): number {
  const n = limit ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > MAX_SYNC_RUNS) throw badInput(`limit must be an integer between 1 and ${MAX_SYNC_RUNS} (got ${n})`);
  return n;
}

const memo = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= fn());
};

type Resolver<P, A, R> = GraphQLFieldResolver<P, Context, A, R>;

export const resolvers = {
  Date: DateScalar,
  DateTime: DateTimeScalar,
  JSON: JSONScalar,

  Query: {
    counties: () => GA_COUNTIES,

    facility: (async (_p, { id }, { prisma }) => prisma.facility.findUnique({ where: { portalId: id } })) as Resolver<unknown, { id: string }, unknown>,

    facilities: (async (_p, args, { prisma }) => {
      const first = pageSize(args.first);
      const base = facilityFilter(args);
      const cursor = afterFacility(args.after);
      const rows = await prisma.facility.findMany({
        where: cursor ? { AND: [base, cursor] } : base,
        orderBy: [...SORT_FACILITIES] as Prisma.FacilityOrderByWithRelationInput[],
        take: first + 1,
      });
      return connection(rows, first, facilityCursor, memo(() => prisma.facility.count({ where: base })));
    }) as Resolver<unknown, FacilitiesArgs, unknown>,

    inspection: (async (_p, { id }, { prisma }) => prisma.inspection.findUnique({ where: { portalId: id } })) as Resolver<unknown, { id: string }, unknown>,

    syncRuns: (async (_p, args, { prisma }) =>
      prisma.syncRun.findMany({
        where: {
          ...(args.county?.trim() ? { county: args.county.trim().toUpperCase() } : {}),
          ...(args.status ? { status: args.status } : {}),
        },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: limitArg(args.limit, 20),
      })) as Resolver<unknown, { limit?: number | null; county?: string | null; status?: SyncRun['status'] | null }, unknown>,

    syncStatus: () => ({}),
  },

  SyncStatus: {
    running: ((_p, _a, { prisma }) =>
      prisma.syncRun.findMany({ where: { status: 'running' }, orderBy: { startedAt: 'desc' } })) as Resolver<unknown, unknown, unknown>,
    lastRuns: ((_p, args: { limit?: number | null }, { prisma }) =>
      prisma.syncRun.findMany({
        where: { status: { not: 'running' } },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: limitArg(args.limit, 10),
      })) as Resolver<unknown, { limit?: number | null }, unknown>,
    lastSuccessAt: (async (_p, _a, { prisma }) => {
      const run = await prisma.syncRun.findFirst({ where: { status: 'ok' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } });
      return run?.finishedAt ?? null;
    }) as Resolver<unknown, unknown, unknown>,
  },

  SyncRun: {
    id: (r: SyncRun) => String(r.id),
  },

  Facility: {
    id: (f: Facility) => f.portalId,
    inspections: (async (f: Facility, args: { first?: number | null; after?: string | null }, { loaders }) => {
      const first = pageSize(args.first);
      const after = args.after ? decodeInspectionCursor(args.after) : undefined;
      const rows = await loaders.inspectionsPage(first + 1, after).load(f.id);
      return connection(rows, first, inspectionCursor, () => loaders.inspectionCountByFacility.load(f.id));
    }) as Resolver<Facility, { first?: number | null; after?: string | null }, unknown>,
  },

  Inspection: {
    id: (i: Inspection) => i.portalId,
    facility: (async (i: Inspection, _a, { loaders }) => {
      const f = await loaders.facilityById.load(i.facilityId);
      if (!f) throw new Error(`facility ${i.facilityId} missing for inspection ${i.portalId}`);
      return f;
    }) as Resolver<Inspection, unknown, unknown>,
    violations: (async (i: Inspection, _a, { loaders }) => {
      const rows = await loaders.violationsByInspection.load(i.id);
      return rows.map((v) => ({ ...v, inspectionPortalId: i.portalId }));
    }) as Resolver<Inspection, unknown, unknown>,
  },

  Violation: {
    id: (v: Violation & { inspectionPortalId: string }) => `${v.inspectionPortalId}:${v.id}`,
  },

  FacilityConnection: { totalCount: (c: Connection<unknown>) => c.totalCount() },
  InspectionConnection: { totalCount: (c: Connection<unknown>) => c.totalCount() },
};
