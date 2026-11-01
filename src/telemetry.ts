import { performance } from 'node:perf_hooks';
import { metrics, trace, SpanStatusCode, type Counter, type Histogram, type Span } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type Sampler,
} from '@opentelemetry/sdk-trace-node';
import type { ApolloServerPlugin } from '@apollo/server';
import { Kind, type DocumentNode, type OperationDefinitionNode, type SelectionSetNode } from 'graphql';
import type { PrismaClient } from '@prisma/client';

// Optional OTLP telemetry. With OTEL_METRICS_URL / OTEL_TRACES_URL unset nothing is installed:
// the instruments below come from the global API, which hands out no-ops until a provider
// is registered, so the plugins stay cheap and safe.
//
// No `unit` on any instrument: names already carry their unit and the Collector's Prometheus
// exporter would append a second suffix.

export interface Telemetry {
  metricsEnabled: boolean;
  tracesEnabled: boolean;
  shutdown(): Promise<void>;
}

export function samplerFromEnv(env: NodeJS.ProcessEnv = process.env): Sampler {
  const name = (env.OTEL_TRACES_SAMPLER ?? 'parentbased_always_on').trim().toLowerCase();
  const arg = Number(env.OTEL_TRACES_SAMPLER_ARG);
  const ratio = Number.isFinite(arg) && arg >= 0 && arg <= 1 && env.OTEL_TRACES_SAMPLER_ARG !== '' && env.OTEL_TRACES_SAMPLER_ARG !== undefined ? arg : 1;
  switch (name) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(ratio);
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
    default:
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

export function initTelemetry(env: NodeJS.ProcessEnv = process.env): Telemetry {
  const resource = resourceFromAttributes({
    'service.name': 'ga-food-scores-graphql',
    'k8s.pod.name': env.POD_NAME ?? 'local',
  });
  let meterProvider: MeterProvider | undefined;
  let tracerProvider: NodeTracerProvider | undefined;

  if (env.OTEL_METRICS_URL) {
    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: env.OTEL_METRICS_URL, timeoutMillis: 10_000 }),
          exportIntervalMillis: 15_000,
          exportTimeoutMillis: 10_000,
        }),
      ],
    });
    metrics.setGlobalMeterProvider(meterProvider);
  }
  if (env.OTEL_TRACES_URL) {
    tracerProvider = new NodeTracerProvider({
      resource,
      sampler: samplerFromEnv(env),
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: env.OTEL_TRACES_URL, timeoutMillis: 10_000 }))],
    });
    trace.setGlobalTracerProvider(tracerProvider);
  }

  return {
    metricsEnabled: !!meterProvider,
    tracesEnabled: !!tracerProvider,
    async shutdown() {
      // Never throw on the way out: the collector may already be gone.
      for (const p of [meterProvider, tracerProvider]) {
        try {
          await p?.forceFlush();
          await p?.shutdown();
        } catch (err) {
          console.error('[telemetry] flush failed:', err instanceof Error ? err.message : err);
        }
      }
    },
  };
}

interface Instruments {
  provider: unknown;
  requests: Counter;
  errors: Counter;
  duration: Histogram;
}
let cached: Instruments | undefined;

// Created lazily per installed provider (instruments made before setGlobalMeterProvider stay no-ops).
function instruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cached?.provider === provider) return cached;
  const meter = metrics.getMeter('ga-food-scores-graphql');
  cached = {
    provider,
    requests: meter.createCounter('graphql_requests_total', {
      description: 'GraphQL operations executed, incremented once per root field',
    }),
    errors: meter.createCounter('graphql_errors_total', {
      description: 'GraphQL operations that returned errors, per root field and error code',
    }),
    duration: meter.createHistogram('graphql_request_duration_ms', {
      description: 'GraphQL operation duration in milliseconds, recorded once per root field',
    }),
  };
  return cached;
}

/** Prisma pool gauges (needs the `metrics` preview feature). Safe to call with no provider. */
export function registerPrismaMetrics(prisma: PrismaClient): void {
  const meter = metrics.getMeter('ga-food-scores-graphql');
  const open = meter.createObservableGauge('prisma_pool_connections_open');
  const busy = meter.createObservableGauge('prisma_pool_connections_busy');
  const idle = meter.createObservableGauge('prisma_pool_connections_idle');
  const durAvg = meter.createObservableGauge('prisma_client_queries_duration_avg_ms');
  const waitAvg = meter.createObservableGauge('prisma_client_queries_wait_avg_ms');
  meter.addBatchObservableCallback(
    async (result) => {
      try {
        const m = await prisma.$metrics.json();
        const gauge = (key: string): number => m.gauges.find((g) => g.key === key)?.value ?? 0;
        const avg = (key: string): number => {
          const h = m.histograms.find((e) => e.key === key)?.value;
          return h && h.count > 0 ? h.sum / h.count : 0;
        };
        result.observe(open, gauge('prisma_pool_connections_open'));
        result.observe(busy, gauge('prisma_pool_connections_busy'));
        result.observe(idle, gauge('prisma_pool_connections_idle'));
        result.observe(durAvg, avg('prisma_client_queries_duration_histogram_ms'));
        result.observe(waitAvg, avg('prisma_client_queries_wait_histogram_ms'));
      } catch {
        /* metrics must never break the process */
      }
    },
    [open, busy, idle, durAvg, waitAvg],
  );
}

// Root fields as responseKey -> schema field name (post-validation, so cardinality is bounded by the
// schema; the client-supplied operationName is deliberately NOT a label).
function rootFields(document: DocumentNode, operation: OperationDefinitionNode): Map<string, string> {
  const fragments = new Map<string, SelectionSetNode>();
  for (const d of document.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d.selectionSet);
  const out = new Map<string, string>();
  const collect = (set: SelectionSetNode): void => {
    for (const s of set.selections) {
      if (s.kind === Kind.FIELD) out.set(s.alias?.value ?? s.name.value, s.name.value);
      else if (s.kind === Kind.INLINE_FRAGMENT) collect(s.selectionSet);
      else {
        const f = fragments.get(s.name.value);
        if (f) collect(f);
      }
    }
  };
  collect(operation.selectionSet);
  return out;
}

const UNRESOLVED = 'unresolved';

/** Request counter/error counter/duration histogram (+ one span per operation when tracing is on). */
export const metricsPlugin: ApolloServerPlugin = {
  async requestDidStart() {
    const start = performance.now();
    let operationType = UNRESOLVED;
    let byKey = new Map<string, string>();
    let fields = [UNRESOLVED];
    const span: Span = trace.getTracer('ga-food-scores-graphql').startSpan('graphql.request');
    return {
      async didResolveOperation({ document, operation }) {
        if (!operation) return;
        operationType = operation.operation;
        byKey = rootFields(document, operation);
        if (byKey.size > 0) fields = [...new Set(byKey.values())];
        span.updateName(`graphql ${operationType} ${fields.join(',')}`);
        span.setAttributes({ 'graphql.operation.type': operationType, 'graphql.root_fields': fields.join(',') });
      },
      async willSendResponse({ response }) {
        const ms = performance.now() - start;
        const codesByField = new Map<string, Set<string>>();
        if (response.body.kind === 'single') {
          for (const e of response.body.singleResult.errors ?? []) {
            const code = String(e.extensions?.code ?? 'UNKNOWN');
            const key = e.path?.[0];
            const field = typeof key === 'string' ? byKey.get(key) : undefined;
            for (const f of field ? [field] : fields) codesByField.set(f, (codesByField.get(f) ?? new Set()).add(code));
          }
        }
        const m = instruments();
        for (const root_field of fields) {
          const attrs = { operation_type: operationType, root_field };
          m.duration.record(ms, attrs);
          m.requests.add(1, attrs);
          for (const error_code of codesByField.get(root_field) ?? []) m.errors.add(1, { ...attrs, error_code });
        }
        if (codesByField.size > 0) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      },
    };
  },
};
