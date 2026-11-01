import { metrics, type Counter, type Histogram } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

// Sync metrics, pushed as OTLP/HTTP to the OTel Collector (same pattern as the
// infra repo's src/telemetry.ts). Instruments come from the global meter, so
// they are no-ops until initSyncMetrics() installs a provider (e.g. in tests).
//
// No `unit` option on any instrument: names already carry their unit, and the
// Collector's Prometheus exporter would append a second unit suffix.

const lastSuccess = new Map<string, number>();

// Instruments are created lazily, per installed provider: the OTel API hands out
// permanent no-op instruments if they are created before a provider is set.
let cached: { provider: unknown; runs: Counter; duration: Histogram; upserted: Counter } | undefined;

function instruments() {
  const provider = metrics.getMeterProvider();
  if (cached?.provider === provider) return cached;
  const meter = metrics.getMeter('ga-food-scores-ingest');
  meter
    .createObservableGauge('sync_last_success_timestamp_seconds', {
      description: 'Unix time of the last successful sync of a county',
    })
    .addCallback((result) => {
      for (const [county, ts] of lastSuccess) result.observe(ts, { county });
    });
  cached = {
    provider,
    runs: meter.createCounter('sync_runs_total', {
      description: 'County sync runs finished, by county and status (ok|failed|interrupted)',
    }),
    duration: meter.createHistogram('sync_duration_seconds', {
      description: 'Wall-clock duration of one county sync in seconds',
      advice: { explicitBucketBoundaries: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200] },
    }),
    upserted: meter.createCounter('facilities_upserted_total', {
      description: 'Facility rows upserted by sync, by county',
    }),
  };
  return cached;
}

export function recordCountySync(county: string, status: 'ok' | 'failed' | 'interrupted', seconds: number, facilitiesUpserted = 0): void {
  const m = instruments();
  m.runs.add(1, { county, status });
  m.duration.record(seconds, { county, status });
  if (facilitiesUpserted > 0) m.upserted.add(facilitiesUpserted, { county });
  if (status === 'ok') lastSuccess.set(county, Math.floor(Date.now() / 1000));
}

export function metricsUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OTEL_METRICS_URL) return env.OTEL_METRICS_URL; // same override as the API server
  const base = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318').replace(/\/+$/, '');
  return `${base}/v1/metrics`;
}

export interface SyncMetricsHandle {
  provider: MeterProvider;
  /** Push everything recorded so far and stop the exporter. Never throws. Call before process exit. */
  flushAndShutdown(): Promise<void>;
}

/** Install the OTLP meter provider. Returns a handle whose flush MUST run before the process exits. */
export function initSyncMetrics(env: NodeJS.ProcessEnv = process.env): SyncMetricsHandle {
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': 'ga-food-scores-ingest',
      'k8s.pod.name': env.POD_NAME ?? 'local',
    }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: metricsUrl(env), timeoutMillis: 10_000 }),
        exportIntervalMillis: 15_000,
        exportTimeoutMillis: 10_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);
  return {
    provider,
    async flushAndShutdown() {
      try {
        await provider.forceFlush();
        await provider.shutdown();
      } catch (err) {
        console.error('[sync] metrics flush failed:', err instanceof Error ? err.message : err);
      }
    },
  };
}
