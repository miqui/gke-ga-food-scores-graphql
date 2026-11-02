// Query protection: depth limit + cost limit. Done in a plugin (not validationRules) because
// variables are only available at didResolveOperation (so `first: $n` is priced correctly) and
// because validation errors get relabelled by Apollo, losing the QUERY_TOO_* codes.
import type { ApolloServerPlugin } from '@apollo/server';
import { GraphQLError, Kind } from 'graphql';
import type { DocumentNode, FragmentDefinitionNode, SelectionSetNode } from 'graphql';
import { fieldExtensionsEstimator, getComplexity } from 'graphql-query-complexity';
import type { ComplexityEstimator } from 'graphql-query-complexity';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_SYNC_RUNS } from './schema.js';

/** facilities > edges > node > inspections > edges > node > violations > code = 8. */
export const MAX_DEPTH = 8;
export const MAX_COMPLEXITY = 10_000;
/**
 * Ceiling for operations that only ask for introspection (__schema / __type). Tooling such as
 * Apollo Sandbox sends the full introspection query, which costs about 50k here; depth ignores
 * `__*` fields, so this ceiling is what still bounds a hand-crafted, deeply nested one.
 */
export const MAX_INTROSPECTION_COMPLEXITY = 100_000;
const LIST_ESTIMATE = 10; // plain list fields without a size argument (violations)

/** Field nesting depth, following fragments. Introspection (__*) fields are not counted. */
export function operationDepth(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  memo = new Map<string, number>(),
  visiting = new Set<string>(),
): number {
  let deepest = 0;
  for (const sel of selectionSet.selections) {
    if (sel.kind === Kind.FIELD) {
      if (sel.name.value.startsWith('__')) continue;
      const below = sel.selectionSet ? operationDepth(sel.selectionSet, fragments, memo, visiting) : 0;
      deepest = Math.max(deepest, 1 + below);
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      deepest = Math.max(deepest, operationDepth(sel.selectionSet, fragments, memo, visiting));
    } else {
      const name = sel.name.value;
      const fragment = fragments.get(name);
      if (!fragment || visiting.has(name)) continue; // cycles are rejected by graphql-js rules
      if (!memo.has(name)) {
        visiting.add(name);
        memo.set(name, operationDepth(fragment.selectionSet, fragments, memo, visiting));
        visiting.delete(name);
      }
      deepest = Math.max(deepest, memo.get(name) ?? 0);
    }
  }
  return deepest;
}

function fragmentsOf(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const m = new Map<string, FragmentDefinitionNode>();
  for (const d of document.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) m.set(d.name.value, d);
  return m;
}

const clamp = (n: unknown, def: number, max: number): number => Math.min(Math.max(Number.isFinite(Number(n)) ? Number(n) : def, 1), max);

/**
 * cost(field) = 1 + cost(children) * multiplier
 *   field with `first` (connections):  clamped first (default page size); edges/nodes cost 1 + children
 *   field with `limit`:                 clamped limit
 *   other list fields:                  LIST_ESTIMATE
 *   totalCount:                         5 (a COUNT query)
 */
export const costEstimator: ComplexityEstimator = ({ field, args, childComplexity }) => {
  if (field.name === 'totalCount') return 5;
  const names = field.args.map((a) => a.name);
  let multiplier = 1;
  if (names.includes('first')) multiplier = clamp(args.first, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  else if (names.includes('limit')) multiplier = clamp(args.limit, 10, MAX_SYNC_RUNS);
  else if (String(field.type).includes('[') && !['edges', 'nodes', 'counties'].includes(field.name)) multiplier = LIST_ESTIMATE;
  return 1 + childComplexity * multiplier;
};

/** True when every root field of the operation is an introspection field (`__schema`, `__type`, ...). */
export function isIntrospectionOnly(selectionSet: SelectionSetNode): boolean {
  return (
    selectionSet.selections.length > 0 &&
    selectionSet.selections.every((s) => s.kind === Kind.FIELD && s.name.value.startsWith('__'))
  );
}

function reject(message: string, code: 'QUERY_TOO_DEEP' | 'QUERY_TOO_COMPLEX'): never {
  throw new GraphQLError(message, { extensions: { code, http: { status: 400 } } });
}

export const queryLimitsPlugin: ApolloServerPlugin = {
  async requestDidStart() {
    return {
      async didResolveOperation({ request, document, operation, schema }) {
        if (!operation) return;
        const depth = operationDepth(operation.selectionSet, fragmentsOf(document));
        if (depth > MAX_DEPTH) reject(`Query depth ${depth} exceeds the maximum of ${MAX_DEPTH}.`, 'QUERY_TOO_DEEP');

        let complexity = 0;
        try {
          complexity = getComplexity({
            schema,
            query: document,
            variables: request.variables,
            operationName: request.operationName,
            estimators: [fieldExtensionsEstimator(), costEstimator],
          });
        } catch {
          return; // e.g. uncoercible variables: execution reports the precise error
        }
        const max = isIntrospectionOnly(operation.selectionSet) ? MAX_INTROSPECTION_COMPLEXITY : MAX_COMPLEXITY;
        if (complexity > max) {
          reject(`Query complexity ${complexity} exceeds the maximum of ${max}.`, 'QUERY_TOO_COMPLEX');
        }
      },
    };
  },
};
