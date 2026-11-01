import { prisma } from './prisma.js';
import { createServer, introspectionFromEnv } from './server.js';
import { initTelemetry, registerPrismaMetrics } from './telemetry.js';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  // Telemetry first so global providers exist before instruments are created.
  const telemetry = initTelemetry();
  const port = Number(process.env.PORT ?? 8080);
  const introspection = introspectionFromEnv();

  const server = createServer({ prisma, introspection });
  // The pool connects lazily; a down database only makes /health/readiness fail, not startup.
  registerPrismaMetrics(prisma);
  await server.start(port);
  console.log(
    JSON.stringify({
      msg: 'listening',
      port,
      introspection,
      metrics: telemetry.metricsEnabled,
      traces: telemetry.tracesEnabled,
    }),
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ msg: 'shutting down', signal }));
    const force = setTimeout(() => {
      console.error(JSON.stringify({ msg: 'shutdown timed out, exiting' }));
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    try {
      await server.stop();
      await prisma.$disconnect();
      await telemetry.shutdown();
      process.exit(0);
    } catch (err) {
      console.error('shutdown failed', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
