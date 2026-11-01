// Prints the schema snapshot from the SDL in src/schema.ts.
//   npm run schema:print  -> (re)writes schema.graphql
//   npm run schema:check  -> exits 1 if schema.graphql differs from the SDL
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildASTSchema, parse, printSchema } from 'graphql';
import { typeDefs } from './schema.js';

export const SNAPSHOT_PATH = fileURLToPath(new URL('../schema.graphql', import.meta.url));

export function printedSchema(): string {
  return `${printSchema(buildASTSchema(parse(typeDefs)))}\n`;
}

function run(): number {
  const printed = printedSchema();
  if (process.argv.includes('--check')) {
    const current = existsSync(SNAPSHOT_PATH) ? readFileSync(SNAPSHOT_PATH, 'utf8') : '';
    if (current !== printed) {
      console.error('schema.graphql is out of date with src/schema.ts: run `npm run schema:print` and commit it.');
      return 1;
    }
    console.log('schema.graphql is up to date');
    return 0;
  }
  writeFileSync(SNAPSHOT_PATH, printed);
  console.log(`wrote ${SNAPSHOT_PATH}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(run());
