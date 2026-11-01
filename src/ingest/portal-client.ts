export interface PortalFacilityRecord {
  id: string;
  name: string;
  mapAddress: string;
  columns: Record<string, string>;
}

export interface PortalViolation {
  code: string;
  ruleCitation: string;
  points: number;
  correctedOnSite: boolean;
  repeat: boolean;
  notes: string;
}

export interface PortalInspectionRecord {
  inspectionId: number;
  facilityId: string;
  printablePath: string;
  date: string; // ISO yyyy-mm-dd
  purpose: string;
  score: number | null;
  inspector: string;
  violations: PortalViolation[];
}

export interface PortalClient {
  /** Search a county's facilities, 5 records/page, newest-inspection-first. 1-indexed pages. */
  searchCounty(county: string, page: number): Promise<PortalFacilityRecord[]>;
  /** Full inspection + violation history for one facility. */
  getInspections(facilityId: string): Promise<PortalInspectionRecord[]>;
}
