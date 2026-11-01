import { PrismaClient } from '@prisma/client';

/** Postgres-backed tests need DATABASE_URL (CI provides a service container); otherwise they skip. */
export const hasDb = !!process.env.DATABASE_URL;

if (!hasDb) {
  console.warn('[test] DATABASE_URL is not set: skipping Postgres-backed tests (see .env.example / docker-compose.yml)');
}

let client: PrismaClient | undefined;
export function testDb(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

/** Empty every table (cascade + identity reset) so each test starts clean. */
export async function resetDb(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE violations, inspections, facilities, sync_state, sync_runs, sync_lock RESTART IDENTITY CASCADE',
  );
}
