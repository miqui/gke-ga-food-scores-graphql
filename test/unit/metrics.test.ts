import { describe, it, expect, afterEach } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { metricsUrl, recordCountySync } from '../../src/ingest/metrics.js';

describe('sync metrics', () => {
  afterEach(() => metrics.disable());

  it('records the documented series and exposes them on forceFlush', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
    });
    metrics.setGlobalMeterProvider(provider);

    recordCountySync('LONG', 'ok', 1.5, 7);
    recordCountySync('BRYAN', 'failed', 0.2);
    await provider.forceFlush();

    const byName = new Map<string, any>();
    for (const rm of exporter.getMetrics()) {
      for (const sm of rm.scopeMetrics) for (const m of sm.metrics) byName.set(m.descriptor.name, m);
    }
    expect([...byName.keys()].sort()).toEqual([
      'facilities_upserted_total',
      'sync_duration_seconds',
      'sync_last_success_timestamp_seconds',
      'sync_runs_total',
    ]);
    const runs = byName.get('sync_runs_total').dataPoints.map((d: any) => [d.attributes.county, d.attributes.status, d.value]);
    expect(runs).toEqual(expect.arrayContaining([['LONG', 'ok', 1], ['BRYAN', 'failed', 1]]));
    const last = byName.get('sync_last_success_timestamp_seconds').dataPoints;
    expect(last.map((d: any) => d.attributes.county)).toEqual(['LONG']);
    await provider.shutdown();
  });

  it('derives the OTLP URL from OTEL_EXPORTER_OTLP_ENDPOINT, with OTEL_METRICS_URL taking precedence', () => {
    expect(metricsUrl({})).toBe('http://localhost:4318/v1/metrics');
    expect(metricsUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318/' })).toBe('http://otel:4318/v1/metrics');
    expect(metricsUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a', OTEL_METRICS_URL: 'http://b/v1/metrics' })).toBe('http://b/v1/metrics');
  });
});
