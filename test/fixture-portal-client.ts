import type { PortalClient, PortalFacilityRecord, PortalInspectionRecord } from '../src/ingest/portal-client.js';

export interface FixtureCountyPages {
  [page: number]: PortalFacilityRecord[];
}

export interface FixturePortalClientOptions {
  pagesByCounty: Record<string, FixtureCountyPages>;
  inspectionsByFacility: Record<string, PortalInspectionRecord[]>;
}

/**
 * Deterministic in-memory PortalClient for tests. Never touches the network.
 * Tracks call counts so tests can assert on rate limiting / walker stop behavior.
 */
export class FixturePortalClient implements PortalClient {
  public searchCalls: Array<{ county: string; page: number }> = [];
  public inspectionCalls: string[] = [];

  constructor(private readonly opts: FixturePortalClientOptions) {}

  async searchCounty(county: string, page: number): Promise<PortalFacilityRecord[]> {
    this.searchCalls.push({ county, page });
    return this.opts.pagesByCounty[county]?.[page] ?? [];
  }

  async getInspections(facilityId: string): Promise<PortalInspectionRecord[]> {
    this.inspectionCalls.push(facilityId);
    return this.opts.inspectionsByFacility[facilityId] ?? [];
  }
}
