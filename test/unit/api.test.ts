import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type GraphqlServer } from '../../src/server.js';
import { hasDb, resetDb, testDb } from '../db.js';

const db = testDb();
const d = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

let server: GraphqlServer;
let base: string;
const logs: Record<string, unknown>[] = [];

async function gql(query: string, variables?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return { status: res.status, body: await res.json() };
}

async function seed(): Promise<void> {
  const mk = (portalId: string, name: string, county: string, city: string, address: string, score: number | null, date: string | null) =>
    db.facility.create({
      data: {
        portalId, name, county, city, address, permitType: 'FSP', lastInspectionScore: score,
        lastInspectionDate: date ? d(date) : null, updatedAt: new Date('2025-01-01T00:00:00Z'),
      },
    });
  const f1 = await mk('F1', "Joe's Pizza", 'FULTON', 'Atlanta', '1 Peachtree St', 95, '2024-05-01');
  await mk('F2', 'Taco Hut', 'FULTON', 'Atlanta', '2 Main St', 80, '2024-05-01');
  await mk('F3', 'Sushi Bar', 'FULTON', 'Roswell', '3 Oak Ave', 70, '2023-01-01');
  await mk('F4', "Joe's Diner", 'COBB', 'Marietta', '4 Elm St', null, null);
  await mk('F5', 'Pie Shop', 'BEN HILL', 'Fitzgerald', '5 Pine Rd', 100, '2022-02-02');

  const i1 = await db.inspection.create({ data: { portalId: 'I1', facilityId: f1.id, inspectionDate: d('2024-05-01'), purpose: 'Routine', score: 95, inspector: 'A' } });
  await db.inspection.create({ data: { portalId: 'I2', facilityId: f1.id, inspectionDate: d('2023-04-01'), score: 88 } });
  await db.inspection.create({ data: { portalId: 'I3', facilityId: f1.id, inspectionDate: d('2022-03-01'), score: 90 } });
  await db.violation.createMany({
    data: [
      { inspectionId: i1.id, code: '3A', points: 3, notes: 'cold holding' },
      { inspectionId: i1.id, code: '5B', points: 5, repeat: true, correctedOnSite: true },
    ],
  });
}

describe.skipIf(!hasDb)('GraphQL API', () => {
  beforeAll(async () => {
    server = createServer({ prisma: db, introspection: false, log: (e) => logs.push(e) });
    base = `http://127.0.0.1:${await server.start(0)}`;
  });
  afterAll(async () => {
    await server.stop();
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDb(db);
    await seed();
    logs.length = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists counties', async () => {
    const { body } = await gql('{ counties }');
    expect(body.data.counties).toHaveLength(159);
    expect(body.data.counties).toContain('FULTON');
  });

  it('resolves a facility with nested inspections and violations', async () => {
    const { body } = await gql(`{
      facility(id: "F1") { id name lastInspectionDate updatedAt
        inspections(first: 10) { totalCount edges { node { id inspectionDate score violations { id code points repeat correctedOnSite } } } } }
    }`);
    const f = body.data.facility;
    expect(f.id).toBe('F1');
    expect(f.lastInspectionDate).toBe('2024-05-01');
    expect(f.updatedAt).toBe('2025-01-01T00:00:00.000Z');
    expect(f.inspections.totalCount).toBe(3);
    expect(f.inspections.edges.map((e: any) => e.node.id)).toEqual(['I1', 'I2', 'I3']);
    const viol = f.inspections.edges[0].node.violations;
    expect(viol.map((v: any) => v.code)).toEqual(['5B', '3A']); // points desc
    expect(viol[0].id).toMatch(/^I1:\d+$/);
    expect(viol[0]).toMatchObject({ repeat: true, correctedOnSite: true });
  });

  it('returns null for unknown ids and resolves inspection(id) with its facility', async () => {
    expect((await gql('{ facility(id: "nope") { id } inspection(id: "nope") { id } }')).body.data).toEqual({ facility: null, inspection: null });
    const { body } = await gql('{ inspection(id: "I1") { id purpose facility { id name } violations { code } } }');
    expect(body.data.inspection).toMatchObject({ id: 'I1', purpose: 'Routine', facility: { id: 'F1', name: "Joe's Pizza" } });
    expect(body.data.inspection.violations).toHaveLength(2);
  });

  it('paginates facilities with stable cursors, nulls last', async () => {
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    for (;;) {
      const { body } = await gql(
        'query($after: String) { facilities(first: 2, after: $after) { totalCount nodes { id } edges { cursor node { id } } pageInfo { hasNextPage endCursor startCursor } } }',
        { after },
      );
      const c = body.data.facilities;
      expect(c.totalCount).toBe(5);
      expect(c.nodes.map((n: any) => n.id)).toEqual(c.edges.map((e: any) => e.node.id));
      seen.push(...c.nodes.map((n: any) => n.id));
      pages++;
      if (!c.pageInfo.hasNextPage) break;
      expect(c.pageInfo.endCursor).toBe(c.edges.at(-1).cursor);
      after = c.pageInfo.endCursor;
    }
    expect(pages).toBe(3);
    // date desc, id asc on ties, never-inspected last
    expect(seen).toEqual(['F1', 'F2', 'F3', 'F5', 'F4']);
  });

  it('applies county, city, minScore and q filters', async () => {
    const ids = async (args: string) => (await gql(`{ facilities(${args}) { totalCount nodes { id } } }`)).body.data.facilities;
    expect((await ids('county: "fulton"')).nodes.map((n: any) => n.id)).toEqual(['F1', 'F2', 'F3']);
    expect((await ids('county: "ben hill"')).nodes.map((n: any) => n.id)).toEqual(['F5']);
    expect((await ids('city: "ATLANTA"')).nodes.map((n: any) => n.id)).toEqual(['F1', 'F2']);
    expect((await ids('minScore: 90')).nodes.map((n: any) => n.id)).toEqual(['F1', 'F5']);
    expect((await ids('q: "JOE"')).nodes.map((n: any) => n.id)).toEqual(['F1', 'F4']); // name, case-insensitive
    expect((await ids('q: "oak ave"')).nodes.map((n: any) => n.id)).toEqual(['F3']); // address
    expect((await ids('q: "marietta"')).nodes.map((n: any) => n.id)).toEqual(['F4']); // city
    const combo = await ids('county: "FULTON", minScore: 80, q: "t"');
    expect(combo.nodes.map((n: any) => n.id)).toEqual(['F1', 'F2']);
    expect(combo.totalCount).toBe(2);
  });

  it('paginates nested inspections', async () => {
    const q = 'query($after: String) { facility(id: "F1") { inspections(first: 2, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } } }';
    const p1 = (await gql(q)).body.data.facility.inspections;
    expect(p1.nodes.map((n: any) => n.id)).toEqual(['I1', 'I2']);
    expect(p1.pageInfo.hasNextPage).toBe(true);
    const p2 = (await gql(q, { after: p1.pageInfo.endCursor })).body.data.facility.inspections;
    expect(p2.nodes.map((n: any) => n.id)).toEqual(['I3']);
    expect(p2.pageInfo.hasNextPage).toBe(false);
  });

  it('batches nested resolvers: one query per level regardless of page size', async () => {
    const inspections = vi.spyOn(db, '$queryRaw');
    const violations = vi.spyOn(db.violation, 'findMany');
    const facilities = vi.spyOn(db.facility, 'findMany');
    const { body } = await gql('{ facilities(first: 5) { nodes { id inspections(first: 5) { nodes { id facility { id } violations { code } } } } } }');
    expect(body.errors).toBeUndefined();
    expect(inspections).toHaveBeenCalledTimes(1);
    expect(violations).toHaveBeenCalledTimes(1);
    // 1 page query + 1 batched facility lookup for Inspection.facility
    expect(facilities).toHaveBeenCalledTimes(2);
  });

  it('rejects out-of-range or malformed arguments', async () => {
    for (const args of ['first: 1000', 'first: 0', 'first: -1', 'minScore: 101', 'minScore: -1', 'after: "garbage"', `q: "${'x'.repeat(101)}"`]) {
      const { body } = await gql(`{ facilities(${args}) { totalCount } }`);
      expect(body.errors?.[0].extensions.code, args).toBe('BAD_USER_INPUT');
    }
    const nested = await gql('{ facility(id: "F1") { inspections(first: 101) { totalCount } } }');
    expect(nested.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    // default and the maximum are accepted
    expect((await gql('{ facilities { nodes { id } } }')).body.errors).toBeUndefined();
    expect((await gql('{ facilities(first: 100) { nodes { id } } }')).body.errors).toBeUndefined();
  });

  it('rejects too-deep and too-costly queries with 400', async () => {
    const deep = await gql('{ facilities(first: 1) { edges { node { inspections(first: 1) { edges { node { facility { inspections { edges { node { id } } } } } } } } } } }');
    expect(deep.status).toBe(400);
    expect(deep.body.errors[0].extensions.code).toBe('QUERY_TOO_DEEP');
    const costly = await gql('{ facilities(first: 100) { nodes { inspections(first: 100) { nodes { violations { code points notes } } } } } }');
    expect(costly.status).toBe(400);
    expect(costly.body.errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
  });

  it('serves sync runs and sync status', async () => {
    const t = (s: string) => new Date(s);
    await db.syncRun.createMany({
      data: [
        { county: 'LONG', owner: 'p1', startedAt: t('2025-01-01T00:00:00Z'), finishedAt: t('2025-01-01T00:01:00Z'), status: 'ok', result: { facilitiesUpserted: 7 } },
        { county: 'BRYAN', owner: 'p1', startedAt: t('2025-01-01T00:02:00Z'), finishedAt: t('2025-01-01T00:03:00Z'), status: 'failed', error: 'portal down' },
        { county: 'FULTON', owner: 'p2', startedAt: t('2025-01-01T00:04:00Z'), status: 'running' },
      ],
    });
    const { body } = await gql(`{
      syncRuns(limit: 2) { id county status result startedAt finishedAt }
      onlyOk: syncRuns(status: ok) { county result }
      byCounty: syncRuns(county: "bryan") { error }
      syncStatus { running { county } lastRuns(limit: 5) { county status } lastSuccessAt }
    }`);
    expect(body.data.syncRuns.map((r: any) => r.county)).toEqual(['FULTON', 'BRYAN']);
    expect(body.data.syncRuns[0].finishedAt).toBeNull();
    expect(body.data.onlyOk).toEqual([{ county: 'LONG', result: { facilitiesUpserted: 7 } }]);
    expect(body.data.byCounty).toEqual([{ error: 'portal down' }]);
    expect(body.data.syncStatus.running).toEqual([{ county: 'FULTON' }]);
    expect(body.data.syncStatus.lastRuns.map((r: any) => r.status)).toEqual(['failed', 'ok']);
    expect(body.data.syncStatus.lastSuccessAt).toBe('2025-01-01T00:01:00.000Z');
    expect((await gql('{ syncRuns(limit: 51) { id } }')).body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('disables introspection when configured off', async () => {
    const { body } = await gql('{ __schema { queryType { name } } }');
    expect(body.errors[0].message).toMatch(/introspection/i);
  });

  it('never logs variables or query text', async () => {
    await gql('query Search($q: String) { facilities(q: $q) { totalCount } }', { q: 'secret-token-123' });
    const line = logs.find((l) => l.msg === 'graphql');
    expect(line).toMatchObject({ operationName: 'Search', operationType: 'query', rootFields: ['facilities'] });
    expect(JSON.stringify(logs)).not.toContain('secret-token-123');
    expect(JSON.stringify(logs)).not.toContain('totalCount');
  });

  it('rejects oversized and malformed bodies', async () => {
    const big = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ counties }', pad: 'x'.repeat(200_000) }),
    });
    expect(big.status).toBe(413);
    const bad = await fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
  });

  it('exposes liveness and readiness', async () => {
    const live = await fetch(`${base}/health/liveness`);
    expect([live.status, await live.json()]).toEqual([200, { status: 'UP' }]);
    const ready = await fetch(`${base}/health/readiness`);
    expect([ready.status, await ready.json()]).toEqual([200, { status: 'UP' }]);
  });

  it('readiness is 503 when the database ping fails', async () => {
    vi.spyOn(db, '$queryRaw').mockRejectedValueOnce(new Error('connection refused'));
    const res = await fetch(`${base}/health/readiness`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).status).toBe('DOWN');
  });
});

describe.skipIf(!hasDb)('GraphQL API introspection on', () => {
  it('serves introspection when enabled', async () => {
    const s = createServer({ prisma: db, introspection: true, log: () => {} });
    const port = await s.start(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __schema { queryType { name } } }' }),
      });
      expect(((await res.json()) as any).data.__schema.queryType.name).toBe('Query');
    } finally {
      await s.stop();
    }
  });
});

describe.skipIf(!hasDb)('GraphQL landing page', () => {
  const getHtml = async (sandbox: boolean) => {
    const s = createServer({ prisma: db, introspection: true, sandbox, log: () => {} });
    const port = await s.start(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/graphql`, { headers: { accept: 'text/html' } });
      return { status: res.status, body: await res.text() };
    } finally {
      await s.stop();
    }
  };
  it('serves the embedded Sandbox only when enabled', async () => {
    const on = await getHtml(true);
    expect(on.status).toBe(200);
    expect(on.body).toMatch(/EmbeddedSandbox|embeddable-sandbox/i);
    const off = await getHtml(false);
    expect(off.body).not.toMatch(/EmbeddedSandbox|embeddable-sandbox/i);
  });
});
