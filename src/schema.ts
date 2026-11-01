// GraphQL SDL for the read-only Georgia food-inspection API. The committed snapshot
// (schema.graphql) is printed from this string: `npm run schema:print` / `schema:check`.

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_SYNC_RUNS = 50;

export const typeDefs = /* GraphQL */ `
  "Calendar date, serialized as YYYY-MM-DD (no time zone)."
  scalar Date

  "Instant in time, serialized as an ISO 8601 UTC string."
  scalar DateTime

  "Arbitrary JSON value."
  scalar JSON

  type Query {
    "All 159 Georgia county names (uppercase, as accepted by the county filter)."
    counties: [String!]!

    "A facility by id (the portal facility id). Null if it does not exist."
    facility(id: ID!): Facility

    """
    Facilities, newest last-inspection first (facilities never inspected come last), ties by
    insertion order. Relay-style cursor pagination; first is 1-${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE}).
    """
    facilities(
      "Exact county name, case-insensitive (e.g. FULTON, ben hill)."
      county: String
      "Exact city name, case-insensitive."
      city: String
      "Only facilities whose latest inspection score is >= this (0-100)."
      minScore: Int
      "Case-insensitive substring match on name, address or city (max 100 chars)."
      q: String
      "Page size, 1-${MAX_PAGE_SIZE}; values outside the range are rejected."
      first: Int = ${DEFAULT_PAGE_SIZE}
      "Opaque cursor from a previous pageInfo.endCursor / edge cursor."
      after: String
    ): FacilityConnection!

    "An inspection by id (the portal inspection id). Null if it does not exist."
    inspection(id: ID!): Inspection

    "Most recent sync runs (per county), newest first. limit is 1-${MAX_SYNC_RUNS}."
    syncRuns(limit: Int = 20, county: String, status: SyncRunStatus): [SyncRun!]!

    "Data freshness: runs in progress plus the latest finished runs."
    syncStatus: SyncStatus!
  }

  type Facility {
    "The portal facility id (opaque base64 string)."
    id: ID!
    name: String!
    address: String!
    city: String!
    county: String!
    permitType: String!
    permitNumber: String!
    phone: String!
    "Score of the most recent inspection, if known."
    lastInspectionScore: Int
    lastInspectionDate: Date
    "True while the inspection history of this facility has not been fully synced yet."
    historyPending: Boolean!
    updatedAt: DateTime!
    "Inspections, newest first. first is 1-${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE})."
    inspections(first: Int = ${DEFAULT_PAGE_SIZE}, after: String): InspectionConnection!
  }

  type Inspection {
    "The portal inspection id."
    id: ID!
    facility: Facility!
    inspectionDate: Date!
    purpose: String!
    score: Int
    inspector: String!
    reportUrl: String!
    violations: [Violation!]!
  }

  type Violation {
    "Synthetic id: <inspection id>:<violation row id>."
    id: ID!
    code: String!
    ruleCitation: String!
    points: Int!
    correctedOnSite: Boolean!
    repeat: Boolean!
    notes: String!
  }

  type FacilityConnection {
    edges: [FacilityEdge!]!
    "Same facilities as edges, without the cursor wrapper."
    nodes: [Facility!]!
    pageInfo: PageInfo!
    "Total matches for the filters. Runs a COUNT query only when selected."
    totalCount: Int!
  }

  type FacilityEdge {
    cursor: String!
    node: Facility!
  }

  type InspectionConnection {
    edges: [InspectionEdge!]!
    nodes: [Inspection!]!
    pageInfo: PageInfo!
    "Total inspections of the facility. Runs a COUNT query only when selected."
    totalCount: Int!
  }

  type InspectionEdge {
    cursor: String!
    node: Inspection!
  }

  type PageInfo {
    hasNextPage: Boolean!
    "Always false: pagination is forward-only."
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  enum SyncRunStatus {
    running
    ok
    failed
    interrupted
  }

  type SyncRun {
    id: ID!
    county: String!
    "Identifier of the sync process (pod/host) that executed the run."
    owner: String!
    startedAt: DateTime!
    finishedAt: DateTime
    status: SyncRunStatus!
    "Counters of a successful run."
    result: JSON
    error: String
  }

  type SyncStatus {
    "Runs currently in progress."
    running: [SyncRun!]!
    "Latest finished (non-running) runs, newest first. limit is 1-${MAX_SYNC_RUNS}."
    lastRuns(limit: Int = 10): [SyncRun!]!
    "Most recent successful sync across all counties."
    lastSuccessAt: DateTime
  }
`;
