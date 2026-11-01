import { GraphQLError } from 'graphql';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './schema.js';

export function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/** Validate a `first` argument: integer in 1..MAX_PAGE_SIZE (rejected, never silently clamped). */
export function pageSize(first: number | null | undefined): number {
  const n = first ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
    throw badInput(`first must be an integer between 1 and ${MAX_PAGE_SIZE} (got ${n})`);
  }
  return n;
}

/** Facility keyset position: ordered by lastInspectionDate DESC NULLS LAST, id ASC. */
export interface FacilityCursor {
  d: string | null; // YYYY-MM-DD or null
  id: number;
}

/** Inspection keyset position: ordered by inspectionDate DESC, id DESC. */
export interface InspectionCursor {
  d: string; // YYYY-MM-DD
  id: number;
}

export function encodeCursor(c: FacilityCursor | InspectionCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function decode(cursor: string): { d: unknown; id: unknown } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (v && typeof v === 'object') return v as { d: unknown; id: unknown };
  } catch {
    /* fall through */
  }
  throw badInput('Invalid cursor');
}

function validId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

export function decodeFacilityCursor(cursor: string): FacilityCursor {
  const { d, id } = decode(cursor);
  if (!validId(id) || !(d === null || (typeof d === 'string' && DATE_RE.test(d)))) throw badInput('Invalid cursor');
  return { d: d as string | null, id };
}

export function decodeInspectionCursor(cursor: string): InspectionCursor {
  const { d, id } = decode(cursor);
  if (!validId(id) || typeof d !== 'string' || !DATE_RE.test(d)) throw badInput('Invalid cursor');
  return { d, id };
}

export const toDateOnly = (d: Date): string => d.toISOString().slice(0, 10);
