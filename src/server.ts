import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { ApolloServer, type ApolloServerPlugin } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { expressMiddleware } from '@as-integrations/express5';
import express, { type ErrorRequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import { queryLimitsPlugin, readOnlyPlugin } from './guards.js';
import { createContext, type Context } from './loaders.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './schema.js';
import { metricsPlugin } from './telemetry.js';

export const JSON_BODY_LIMIT = '100kb';
const READINESS_TIMEOUT_MS = 2000;

/** GRAPHQL_INTROSPECTION=true|false; default on outside production, off in production. */
export function introspectionFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GRAPHQL_INTROSPECTION?.trim().toLowerCase();
  if (!raw) return env.NODE_ENV !== 'production';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`GRAPHQL_INTROSPECTION must be "true" or "false", got "${env.GRAPHQL_INTROSPECTION}"`);
}

/**
 * GRAPHQL_SANDBOX=true|false; default off everywhere. When on, GET /graphql serves the embedded
 * Apollo Sandbox (it needs introspection, so enable GRAPHQL_INTROSPECTION too). Embedded means the
 * page runs the requests, so no CORS configuration is needed.
 */
export function sandboxFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GRAPHQL_SANDBOX?.trim().toLowerCase();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`GRAPHQL_SANDBOX must be "true" or "false", got "${env.GRAPHQL_SANDBOX}"`);
}

type LogFn = (entry: Record<string, unknown>) => void;
const stdoutLog: LogFn = (entry) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));

/**
 * One JSON line per operation: name, type, root fields, duration, status, error codes.
 * Deliberately never logs the query text, variables, headers or error messages from resolvers
 * (variables may carry user-supplied search text; details stay out of the log pipeline).
 */
export function requestLogPlugin(log: LogFn): ApolloServerPlugin<Context> {
  return {
    async requestDidStart() {
      const start = performance.now();
      let operationType: string | undefined;
      let rootFields: string[] | undefined;
      let operationName: string | undefined;
      return {
        async didResolveOperation({ operation }) {
          operationType = operation?.operation;
          operationName = operation?.name?.value;
          rootFields = operation?.selectionSet.selections.flatMap((s) => (s.kind === 'Field' ? [s.name.value] : []));
        },
        async willSendResponse({ request, response }) {
          const body = response.body;
          const errors = body.kind === 'single' ? (body.singleResult.errors ?? []) : [];
          log({
            level: errors.length > 0 ? 'warn' : 'info',
            msg: 'graphql',
            operationName: (operationName ?? request.operationName)?.slice(0, 64) ?? null,
            operationType: operationType ?? null,
            rootFields: rootFields ?? null,
            durationMs: Math.round(performance.now() - start),
            httpStatus: response.http.status ?? 200,
            errorCodes: errors.map((e) => e.extensions?.code ?? 'UNKNOWN'),
          });
        },
      };
    },
  };
}

export interface ServerOptions {
  prisma: PrismaClient;
  introspection?: boolean;
  sandbox?: boolean;
  log?: LogFn;
}

export interface GraphqlServer {
  app: express.Express;
  apollo: ApolloServer<Context>;
  httpServer: http.Server;
  /** Start Apollo and listen. Resolves with the bound port (use port 0 in tests). */
  start(port: number): Promise<number>;
  /** Flip readiness to 503, stop accepting, drain Apollo and the HTTP server. Does not touch prisma. */
  stop(): Promise<void>;
}

export function createServer(opts: ServerOptions): GraphqlServer {
  const { prisma } = opts;
  const log = opts.log ?? stdoutLog;
  const sandbox = opts.sandbox ?? sandboxFromEnv();
  const introspection = opts.introspection ?? introspectionFromEnv();
  if (sandbox && !introspection) {
    throw new Error('Apollo Sandbox requires introspection to be enabled');
  }
  let shuttingDown = false;

  const apollo = new ApolloServer<Context>({
    typeDefs,
    resolvers,
    plugins: [
      metricsPlugin as ApolloServerPlugin<Context>,
      requestLogPlugin(log),
      readOnlyPlugin as ApolloServerPlugin<Context>,
      queryLimitsPlugin as ApolloServerPlugin<Context>,
      sandbox
        ? ApolloServerPluginLandingPageLocalDefault({ embed: true, includeCookies: false })
        : ApolloServerPluginLandingPageDisabled(),
    ],
    introspection,
    includeStacktraceInErrorResponses: false,
    maxRecursiveSelections: true,
    formatError: (formatted, error) => {
      // Resolver/Prisma failures can carry SQL and connection details: log them, don't return them.
      if (formatted.extensions?.code === 'INTERNAL_SERVER_ERROR') {
        log({ level: 'error', msg: 'internal error', error: error instanceof Error ? error.message : String(error) });
        return { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } };
      }
      return formatted;
    },
  });

  const app = express();
  app.disable('x-powered-by');

  app.get('/health/liveness', (_req, res) => {
    res.status(200).json({ status: 'UP' });
  });
  app.get('/health/readiness', async (_req, res) => {
    if (shuttingDown) {
      res.status(503).json({ status: 'DOWN', reason: 'shutting down' });
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('database ping timed out')), READINESS_TIMEOUT_MS);
        }),
      ]);
      res.status(200).json({ status: 'UP' });
    } catch (err) {
      log({ level: 'warn', msg: 'readiness failed', error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ status: 'DOWN', reason: 'database unavailable' });
    } finally {
      clearTimeout(timer);
    }
  });

  const httpServer = http.createServer(app);
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;

  // Body-parser failures (malformed JSON, > JSON_BODY_LIMIT) answered as GraphQL-shaped JSON errors.
  const bodyError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    const [message, code] =
      status === 413
        ? ['Request body too large', 'PAYLOAD_TOO_LARGE']
        : status === 500
          ? ['Internal server error', 'INTERNAL_SERVER_ERROR']
          : ['Invalid request body', 'BAD_REQUEST'];
    res.status(status).json({ errors: [{ message, extensions: { code } }] });
  };

  return {
    app,
    apollo,
    httpServer,
    async start(port) {
      await apollo.start();
      app.use(
        '/graphql',
        express.json({ limit: JSON_BODY_LIMIT }),
        expressMiddleware(apollo, { context: async () => createContext(prisma) }),
        bodyError,
      );
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, resolve);
      });
      return (httpServer.address() as { port: number }).port;
    },
    async stop() {
      shuttingDown = true;
      await new Promise<void>((resolve) => {
        if (!httpServer.listening) return resolve();
        httpServer.close(() => resolve());
        httpServer.closeIdleConnections();
      });
      await apollo.stop();
    },
  };
}
