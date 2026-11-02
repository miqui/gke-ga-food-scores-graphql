# GraphQL API

Read-only GraphQL API over Georgia restaurant inspection data (synced from the state portal into Postgres).
Endpoint: `POST /graphql` (port 8080). No authentication, no mutations. Schema snapshot: [`schema.graphql`](../schema.graphql)
(regenerate with `npm run schema:print`, verified by `npm run schema:check` and a unit test).

Health: `GET /health/liveness` (always 200 while the process runs), `GET /health/readiness` (200 after a DB `SELECT 1`, 503 if the DB
is unreachable or the server is shutting down).

All responses below were produced by the built server (`node dist/index.js`) against Postgres 16 populated by `node dist/ingest.js LONG`
(38 facilities, 165 inspections, 81 violations). Long values are trimmed with `...`.

## Schema summary

- `counties: [String!]!` - the 159 county names.
- `facility(id: ID!): Facility`, `inspection(id: ID!): Inspection` - null when not found.
- `facilities(county, city, minScore, q, first = 25, after): FacilityConnection!` - Relay-style connection (`edges`, `nodes`,
  `pageInfo`, `totalCount`).
- `syncRuns(limit = 20, county, status): [SyncRun!]!`, `syncStatus { running lastRuns(limit = 10) lastSuccessAt }`.
- `Facility.inspections(first = 25, after): InspectionConnection!`, `Inspection.violations: [Violation!]!`, `Inspection.facility`.
- Scalars: `Date` (`YYYY-MM-DD`), `DateTime` (ISO 8601 UTC), `JSON` (sync run `result`).

### Filters and semantics

- `county`: exact, case-insensitive (stored uppercase). `city`: exact, case-insensitive.
- `minScore`: `lastInspectionScore >= minScore`, integer 0-100 (facilities without a score are excluded).
- `q`: case-insensitive substring of name, address or city (max 100 chars). Filters combine with AND.
- Order: `lastInspectionDate` descending, never-inspected facilities last, ties by internal id. Inspections: date descending.
- Pagination is forward-only. Cursors are opaque (base64url JSON of the sort keys); pass `pageInfo.endCursor` as `after`.
  `totalCount` runs a `COUNT(*)` only when it is selected.

### IDs

`Facility.id` is the portal facility id and `Inspection.id` the portal inspection id (both strings, usable directly in
`facility(id:)` / `inspection(id:)`). `Violation.id` is synthetic: `<inspection id>:<violation row id>` (e.g. `57558169:1`).
No Relay global-ID encoding.

### Limits (query protection)

- `first` must be 1-100 (default 25); out-of-range values are **rejected** with `BAD_USER_INPUT` (not clamped). `syncRuns.limit` 1-50.
- Depth limit 8 (`facilities > edges > node > inspections > edges > node > violations > code`); `QUERY_TOO_DEEP`, HTTP 400.
- Cost limit 10000: `cost(field) = 1 + cost(children) * multiplier`, multiplier = `first`/`limit` (clamped) or 10 for plain
  lists, `totalCount` = 5; `QUERY_TOO_COMPLEX`, HTTP 400.
- JSON request body limit 100 kB (413 beyond that).
- Introspection is off by default in production (`NODE_ENV=production`), on otherwise; override with
  `GRAPHQL_INTROSPECTION=true|false`.
- Browser testing: with `GRAPHQL_SANDBOX=true` (on in the dev cluster), opening `/graphql` in a browser loads the
  embedded Apollo Sandbox; paste the examples below into it.
- Nested data is batched with DataLoader: a page of facilities with inspections and violations costs one SQL statement per level.

## Examples

### Facilities, filtered and paginated

```graphql
{ facilities(county: "long", first: 2) { totalCount pageInfo { hasNextPage endCursor } nodes { id name city lastInspectionScore lastInspectionDate } } }
```
```json
{"data":{"facilities":{"totalCount":38,"pageInfo":{"hasNextPage":true,"endCursor":"<cursor>"},"nodes":[
 {"id":"MTI3NzIzNjA=","name":"Antojitos Latinosy Taqueria","city":"GLENNVILLE","lastInspectionScore":95,"lastInspectionDate":"2026-10-20"},
 {"id":"MTMwMDYyMTk=","name":"Genesis Cafe","city":"LUDOWICI","lastInspectionScore":100,"lastInspectionDate":"2026-09-04"}]}}}
```

Next page, with `$a` set to the previous `endCursor`:

```graphql
query($a: String) { facilities(county: "LONG", first: 2, after: $a) { pageInfo { hasNextPage } nodes { id name lastInspectionDate } } }
```
```json
{"data":{"facilities":{"pageInfo":{"hasNextPage":true},"nodes":[
 {"id":"MTMwMTcyMzY=","name":"Selena's Kitchen (Mobile)","lastInspectionDate":"2026-09-04"},
 {"id":"MTMwMTcyODQ=","name":"Emmanuel Coffee Co. DBA Genesis Cafe (BOO)","lastInspectionDate":"2026-09-04"}]}}}
```

Combined filters:

```graphql
{ facilities(city: "ludowici", q: "CAFE", minScore: 90) { totalCount nodes { name city lastInspectionScore } } }
```
```json
{"data":{"facilities":{"totalCount":5,"nodes":[{"name":"Genesis Cafe","city":"LUDOWICI","lastInspectionScore":100}, ...]}}}
```

### Facility with nested inspections and violations

```graphql
query($id: ID!) { facility(id: $id) { id name county permitType updatedAt
  inspections(first: 2) { totalCount pageInfo { hasNextPage endCursor }
    edges { node { id inspectionDate purpose score violations { id code points correctedOnSite repeat notes } } } } } }
```
variables `{"id":"MTI3NzIzNjA="}`
```json
{"data":{"facility":{"id":"MTI3NzIzNjA=","name":"Antojitos Latinosy Taqueria","county":"LONG","permitType":"Food Service",
 "updatedAt":"2026-10-30T17:06:10.088Z","inspections":{"totalCount":7,"pageInfo":{"hasNextPage":true,"endCursor":"<cursor>"},
 "edges":[{"node":{"id":"57558169","inspectionDate":"2026-10-20","purpose":"Routine","score":95,"violations":[
  {"id":"57558169:1","code":"4-2B - food-contact surfaces: cleaned & sanitized","points":4,"correctedOnSite":true,"repeat":false,"notes":"Observed ... "},
  {"id":"57558169:2","code":"15B - warewashing facilities: installed, maintained, used; test strips","points":1,"correctedOnSite":false,"repeat":false,"notes":"..."}]}}, ...]}}}}
```

### Inspection by id

```graphql
query($id: ID!) { inspection(id: $id) { id inspectionDate score reportUrl facility { id name } violations { code points } } }
```
variables `{"id":"57558169"}`
```json
{"data":{"inspection":{"id":"57558169","inspectionDate":"2026-10-20","score":95,"reportUrl":"../../_templates/87/food_2015/_report_full.cfm?fsimID=57558169&...",
 "facility":{"id":"MTI3NzIzNjA=","name":"Antojitos Latinosy Taqueria"},
 "violations":[{"code":"4-2B - food-contact surfaces: cleaned & sanitized","points":4},{"code":"15B - warewashing facilities: installed, maintained, used; test strips","points":1}]}}}
```

### Sync runs and data freshness

```graphql
{ syncRuns(limit: 2) { id county status startedAt finishedAt result } }
```
```json
{"data":{"syncRuns":[{"id":"1","county":"LONG","status":"ok","startedAt":"2026-10-30T17:06:08.988Z","finishedAt":"2026-10-30T17:06:59.449Z",
 "result":{"county":"LONG","pagesWalked":8,"newWatermark":"2026-10-20","facilitiesSeen":38,"facilitiesUpserted":38,"inspectionsUpserted":165,"violationsUpserted":81,...}}]}}
```
```graphql
{ syncStatus { running { county } lastSuccessAt lastRuns(limit: 1) { county status } } }
```
```json
{"data":{"syncStatus":{"running":[],"lastSuccessAt":"2026-10-30T17:06:59.449Z","lastRuns":[{"county":"LONG","status":"ok"}]}}}
```

## Errors

`first: 1000` (HTTP 200, GraphQL error):
```json
{"errors":[{"message":"first must be an integer between 1 and 100 (got 1000)","locations":[{"line":1,"column":3}],"path":["facilities"],"extensions":{"code":"BAD_USER_INPUT"}}],"data":null}
```
Too deep (HTTP 400):
```json
{"errors":[{"message":"Query depth 11 exceeds the maximum of 8.","extensions":{"code":"QUERY_TOO_DEEP"}}]}
```
Too costly (HTTP 400; `facilities(first:100){ nodes{ inspections(first:100){ nodes{ violations{...} } } } }`):
```json
{"errors":[{"message":"Query complexity 320201 exceeds the maximum of 10000.","extensions":{"code":"QUERY_TOO_COMPLEX"}}]}
```
Introspection with the production default (HTTP 400):
```json
{"errors":[{"message":"GraphQL introspection is not allowed by Apollo Server, but the query contained __schema or __type. ...","extensions":{"validationErrorCode":"INTROSPECTION_DISABLED","code":"GRAPHQL_VALIDATION_FAILED"}}]}
```
Body over 100 kB (HTTP 413):
```json
{"errors":[{"message":"Request body too large","extensions":{"code":"PAYLOAD_TOO_LARGE"}}]}
```
Unexpected server errors are returned as `Internal server error` (details only in the server log).

## Operations

- Env: `DATABASE_URL`, `PORT` (8080), `GRAPHQL_INTROSPECTION`, `GRAPHQL_SANDBOX`, `OTEL_METRICS_URL`, `OTEL_TRACES_URL`, `OTEL_TRACES_SAMPLER`,
  `OTEL_TRACES_SAMPLER_ARG`, `POD_NAME`. Telemetry is a no-op when the OTEL URLs are unset.
- Metrics: `graphql_requests_total`, `graphql_errors_total`, `graphql_request_duration_ms` (labels `operation_type`, `root_field`,
  `error_code`; client operation names are deliberately not labels) and `prisma_pool_connections_{open,busy,idle}`,
  `prisma_client_queries_{duration,wait}_avg_ms`.
- Logs: one JSON line per operation (name, type, root fields, duration, status, error codes). Query text and variables are never logged.
- `SIGTERM`/`SIGINT`: readiness flips to 503, HTTP server and Apollo drain, Prisma disconnects, telemetry flushes (10 s hard cap).
- Migrations are not run by the server (`prisma migrate deploy` in the PreSync hook).
