// Entrypoint for the sync job: `node dist/ingest.js [COUNTY...]` (see src/ingest/cli.ts).
import { main } from './ingest/cli.js';

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error('[sync] fatal error:', err);
    process.exitCode = 1;
  },
);
