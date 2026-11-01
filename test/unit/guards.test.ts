import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Kind, parse, type FragmentDefinitionNode, type OperationDefinitionNode } from 'graphql';
import { MAX_DEPTH, operationDepth } from '../../src/guards.js';
import { decodeFacilityCursor, decodeInspectionCursor, encodeCursor, pageSize } from '../../src/pagination.js';
import { introspectionFromEnv } from '../../src/server.js';
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
  it('introspection defaults off in production, on elsewhere, and honours the flag', () => {
    expect(introspectionFromEnv({ NODE_ENV: 'production' })).toBe(false);
    expect(introspectionFromEnv({})).toBe(true);
    expect(introspectionFromEnv({ NODE_ENV: 'production', GRAPHQL_INTROSPECTION: 'true' })).toBe(true);
    expect(introspectionFromEnv({ GRAPHQL_INTROSPECTION: 'FALSE' })).toBe(false);
    expect(() => introspectionFromEnv({ GRAPHQL_INTROSPECTION: 'yes' })).toThrow();
  });
  it('builds a sampler from OTEL_TRACES_SAMPLER*', () => {
    expect(samplerFromEnv({}).toString()).toMatch(/ParentBased/);
    expect(samplerFromEnv({ OTEL_TRACES_SAMPLER: 'always_off' }).toString()).toMatch(/AlwaysOff/);
    expect(samplerFromEnv({ OTEL_TRACES_SAMPLER: 'parentbased_traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.25' }).toString()).toMatch(/TraceIdRatioBased\{0\.25\}/);
  });
});
