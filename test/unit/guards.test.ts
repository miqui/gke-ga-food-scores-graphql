import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import { Kind, parse, type FragmentDefinitionNode, type OperationDefinitionNode } from 'graphql';
import { MAX_DEPTH, operationDepth } from '../../src/guards.js';
import { decodeFacilityCursor, decodeInspectionCursor, encodeCursor, pageSize } from '../../src/pagination.js';
import { createServer, introspectionFromEnv, sandboxFromEnv } from '../../src/server.js';
import { printedSchema, SNAPSHOT_PATH } from '../../src/print-schema.js';
import { samplerFromEnv } from '../../src/telemetry.js';

function depthOf(query: string): number {
  const doc = parse(query);
  const op = doc.definitions.find((x): x is OperationDefinitionNode => x.kind === Kind.OPERATION_DEFINITION)!;
  const frags = new Map(doc.definitions.filter((x): x is FragmentDefinitionNode => x.kind === Kind.FRAGMENT_DEFINITION).map((f) => [f.name.value, f]));
  return operationDepth(op.selectionSet, frags);
}

describe('schema snapshot', () => {
  it('schema.graphql matches src/schema.ts (run `npm run schema:print` if this fails)', () => {
    expect(readFileSync(SNAPSHOT_PATH, 'utf8')).toBe(printedSchema());
  });
});

describe('depth', () => {
  it('counts nesting, follows fragments, ignores introspection', () => {
    expect(depthOf('{ counties }')).toBe(1);
    expect(depthOf('{ facility(id: "x") { inspections { edges { node { violations { code } } } } } }')).toBe(6);
    expect(depthOf('query { facility(id: "x") { ...F } } fragment F on Facility { inspections { nodes { id } } }')).toBe(4);
    expect(depthOf('{ __schema { types { fields { type { ofType { ofType { name } } } } } } }')).toBe(0);
    expect(MAX_DEPTH).toBe(8);
  });
});

describe('pagination helpers', () => {
  it('pageSize defaults to 25 and rejects out-of-range values', () => {
    expect(pageSize(undefined)).toBe(25);
    expect(pageSize(100)).toBe(100);
    for (const n of [0, 101, -5, 1.5]) expect(() => pageSize(n)).toThrow(/between 1 and 100/);
  });
  it('round-trips cursors and rejects tampered ones', () => {
    expect(decodeFacilityCursor(encodeCursor({ d: '2024-05-01', id: 3 }))).toEqual({ d: '2024-05-01', id: 3 });
    expect(decodeFacilityCursor(encodeCursor({ d: null, id: 9 }))).toEqual({ d: null, id: 9 });
    expect(decodeInspectionCursor(encodeCursor({ d: '2024-05-01', id: 3 }))).toEqual({ d: '2024-05-01', id: 3 });
    expect(() => decodeFacilityCursor('!!!')).toThrow(/Invalid cursor/);
    expect(() => decodeFacilityCursor(Buffer.from('{"d":"x","id":1}').toString('base64url'))).toThrow(/Invalid cursor/);
    expect(() => decodeInspectionCursor(encodeCursor({ d: null as unknown as string, id: 1 }))).toThrow(/Invalid cursor/);
  });
});

describe('config', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('introspection defaults off in production, on elsewhere, and honours the flag', () => {
    expect(introspectionFromEnv({ NODE_ENV: 'production' })).toBe(false);
    expect(introspectionFromEnv({})).toBe(true);
    expect(introspectionFromEnv({ NODE_ENV: 'production', GRAPHQL_INTROSPECTION: 'true' })).toBe(true);
    expect(introspectionFromEnv({ GRAPHQL_INTROSPECTION: 'FALSE' })).toBe(false);
    expect(() => introspectionFromEnv({ GRAPHQL_INTROSPECTION: 'yes' })).toThrow();
  });
  it('sandbox is off by default and honours the flag', () => {
    expect(sandboxFromEnv({})).toBe(false);
    expect(sandboxFromEnv({ NODE_ENV: 'production' })).toBe(false);
    expect(sandboxFromEnv({ GRAPHQL_SANDBOX: 'TRUE' })).toBe(true);
    expect(sandboxFromEnv({ GRAPHQL_SANDBOX: 'false' })).toBe(false);
    expect(() => sandboxFromEnv({ GRAPHQL_SANDBOX: 'yes' })).toThrow();
  });
  it('rejects Sandbox without effective introspection, including defaults and overrides', () => {
    const prisma = {} as PrismaClient;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('GRAPHQL_SANDBOX', 'true');
    vi.stubEnv('GRAPHQL_INTROSPECTION', '');
    expect(() => createServer({ prisma })).toThrow(/sandbox requires introspection/i);
    expect(() => createServer({ prisma, introspection: false })).toThrow(/sandbox requires introspection/i);
    vi.stubEnv('GRAPHQL_SANDBOX', 'false');
    vi.stubEnv('GRAPHQL_INTROSPECTION', 'false');
    expect(() => createServer({ prisma, sandbox: true })).toThrow(/sandbox requires introspection/i);
    expect(() => createServer({ prisma, sandbox: true, introspection: true })).not.toThrow();
    expect(() => createServer({ prisma, sandbox: false })).not.toThrow();
  });
  it('applies resolved Sandbox and introspection overrides', async () => {
    vi.stubEnv('GRAPHQL_SANDBOX', 'false');
    vi.stubEnv('GRAPHQL_INTROSPECTION', 'false');
    const server = createServer({ prisma: {} as PrismaClient, sandbox: true, introspection: true });
    try {
      const port = await server.start(0);
      const landing = await fetch(`http://127.0.0.1:${port}/graphql`, { headers: { accept: 'text/html' } });
      expect(await landing.text()).toMatch(/EmbeddedSandbox|embeddable-sandbox/i);
      const result = await server.apollo.executeOperation({ query: '{ __schema { queryType { name } } }' });
      expect(result.body.kind).toBe('single');
      if (result.body.kind === 'single') expect(result.body.singleResult.errors).toBeUndefined();
    } finally {
      await server.stop();
    }
  });
  it('builds a sampler from OTEL_TRACES_SAMPLER*', () => {
    expect(samplerFromEnv({}).toString()).toMatch(/ParentBased/);
    expect(samplerFromEnv({ OTEL_TRACES_SAMPLER: 'always_off' }).toString()).toMatch(/AlwaysOff/);
    expect(samplerFromEnv({ OTEL_TRACES_SAMPLER: 'parentbased_traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.25' }).toString()).toMatch(/TraceIdRatioBased\{0\.25\}/);
  });
});
