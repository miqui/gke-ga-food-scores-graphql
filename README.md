# gke-ga-food-scores-graphql

A read-only GraphQL API (Apollo Server 5 + Prisma 6 + Postgres 16) for Georgia restaurant
food-inspection scores, plus a daily ingest job that copies the public Georgia DPH inspection
portal into Postgres. It adapts the REST API [miqui/ga-food-scores](https://github.com/miqui/ga-food-scores)
and runs on the dev GKE platform from [miqui/gke-graphql-apollo-prisma-o2](https://github.com/miqui/gke-graphql-apollo-prisma-o2)
(see [PROVENANCE.md](PROVENANCE.md)).

Product decisions: queries only (no mutations), no application auth (the Cloud Armor allowlist is
the only gate on the dev cluster), no Hazelcast, Cloud SQL for Postgres 16 (20 GB, autoresize, no backups).

## Architecture

Diagram source: [gke-architecture.drawio](gke-architecture.drawio) (open in diagrams.net).

```
 GA DPH inspection portal (public web)
            ^  HTTPS (via Cloud NAT)
            |
   food-sync CronJob  (daily 03:00 UTC, node dist/ingest.js)
            |  upserts                       OTLP metrics
            v                                    |
   Cloud SQL Postgres 16  <---- food-service ----+--> OTel Collector -> Prometheus/Grafana/OpenObserve
   (private IP, claim in          Deployment        (/graphql, /health/liveness|readiness, :8080)
    Argo app graphql-db)               ^
            ^                          |
   Argo PreSync Job food-migrate       |  GKE Gateway + Cloud Armor allowlist
   (prisma migrate deploy)             |
                                     clients
```

- One image (`food-service`) serves three roles: Deployment (default `ENTRYPOINT node dist/index.js`),
  CronJob (`node dist/ingest.js`) and the migration hook (`node_modules/.bin/prisma migrate deploy`).
  The server does NOT run migrations.
- Argo CD apps: the main app (Deployment, Service, Gateway, CronJob, migrate hook, NetworkPolicies,
  observability) and `graphql-db` (Cloud SQL Crossplane claim + ExternalSecret).
- Pods carry `app: food-service` (server), `app: food-sync` (CronJob) and `app: food-migrate` (hook);
  the NetworkPolicies select on those labels.

## API overview

`POST /graphql` on port 8080; health at `/health/liveness` and `/health/readiness`.
Queries: `counties`, `facility(id)`, `facilities(county, city, minScore, q, first, after)` (cursor
pagination, nested `inspections` and `violations`), `inspection(id)`, `syncRuns` and `syncStatus`
(data freshness). Depth, cost and page-size limits are enforced. Full schema, semantics, examples and
errors: [docs/API.md](docs/API.md); SDL snapshot: [schema.graphql](schema.graphql)
(`npm run schema:check` keeps it in sync).

## How to use this API

The dev API is `https://graphql.miqui.dev/graphql`. It is read-only (queries only) and only reachable from the
allowlisted IP (Cloud Armor, see [docs/DEPLOY.md](docs/DEPLOY.md)). Locally it is `http://localhost:8080/graphql`.

**1. Open the Sandbox.** In a browser, open `https://graphql.miqui.dev/graphql`: it serves the embedded Apollo Sandbox
(`GRAPHQL_SANDBOX=true`), with the schema, docs and autocompletion. Paste any query below into it.

**2. Or use curl.** Every request is a `POST` with a JSON body holding `query` and, optionally, `variables`:

```
curl -s https://graphql.miqui.dev/graphql \
  -H 'content-type: application/json' \
  --data '{"query":"{ facilities(county: \"BRYAN\", first: 2) { totalCount nodes { name city lastInspectionScore } } }"}'
# {"data":{"facilities":{"totalCount":211,"nodes":[{"name":"...","city":"RICHMOND HILL","lastInspectionScore":100},...]}}}

curl -s https://graphql.miqui.dev/graphql -H 'content-type: application/json' --data '{
  "query": "query($county: String, $min: Int) { facilities(county: $county, minScore: $min, first: 3) { nodes { name } } }",
  "variables": { "county": "BRYAN", "min": 95 }
}'
```

**3. Know the response shape.** Success is `{"data": ...}`. A resolver or input error is `{"data": null, "errors": [{"message", "extensions": {"code"}}]}`
(usually HTTP 200, code `BAD_USER_INPUT`). Invalid or too expensive queries get HTTP 400 (`GRAPHQL_VALIDATION_FAILED`,
`QUERY_TOO_DEEP`, `QUERY_TOO_COMPLEX`). Ids are opaque strings: copy them from a `facilities` result.

**4. Remember the limits.** `first` is 1-100 (default 25), pagination is forward-only with `after`, nesting depth is at most 8,
query cost at most 10,000 (see [docs/API.md](docs/API.md)).

### Example queries

Each query below is run and checked against the live API by [k6/api-examples.js](k6/api-examples.js), which asserts on the
results (filters hold, order is newest first, pages are disjoint and complete, errors carry the documented codes). Verify
them yourself with [k6](https://k6.io/docs/get-started/installation/):

```
k6 run k6/api-examples.js                                    # against https://graphql.miqui.dev
k6 run -e BASE_URL=http://localhost:8080 k6/api-examples.js  # against a local server with synced data
```

The script discovers its own data (a big county, a small one, a facility with several inspections), so it keeps
working as the data changes; it exits non-zero if any check fails. The section below is generated from
[k6/catalog.js](k6/catalog.js): edit that file and run `npm run docs:queries` (`npm run docs:queries:check` verifies it).

<!-- queries:start -->
<!-- Generated from k6/catalog.js by `npm run docs:queries`. Do not edit by hand. -->

49 queries, grouped by task. Values (BRYAN, RICHMOND HILL, ids) come from the dev data set.

<details>
<summary><b>Getting started</b> (Q1-Q3)</summary>

**Q1. Ping**

The cheapest valid request: the type name of the root.

```graphql
{ __typename }
```

**Q2. List the counties**

All 159 Georgia counties, upper case: the exact values the `county` filter accepts.

```graphql
{ counties }
```

**Q3. Discover a type with introspection**

What can I ask a `Facility`? (Introspection is on in the dev cluster.)

```graphql
{ __type(name: "Facility") { name fields { name type { kind name ofType { name } } } } }
```

</details>

<details>
<summary><b>Listing facilities</b> (Q4-Q18)</summary>

**Q4. First page of a county**

Newest last inspection first. `totalCount` runs a `COUNT(*)`, so only ask for it when you need it.

```graphql
{ facilities(county: "BRYAN", first: 5) {
  totalCount
  pageInfo { hasNextPage endCursor }
  nodes { id name city county lastInspectionScore lastInspectionDate }
} }
```

**Q5. Edges and cursors**

Use `edges { cursor node { ... } }` when you want a cursor for every row, not just the last one.

```graphql
{ facilities(county: "BRYAN", first: 3) {
  edges { cursor node { id name } }
  pageInfo { startCursor endCursor hasNextPage hasPreviousPage }
} }
```

**Q6. Filter by county (case-insensitive)**

`county` is an exact match, ignoring case, so `bryan`, `Bryan` and `BRYAN` are the same.

```graphql
{ facilities(county: "bryan", first: 3) { totalCount nodes { name county } } }
```

**Q7. Filter by city**

`city` is an exact match, ignoring case.

```graphql
{ facilities(city: "richmond hill", first: 3) { totalCount nodes { name city } } }
```

**Q8. Search by name**

`q` is a case-insensitive substring of the name, address or city (max 100 characters).

```graphql
{ facilities(county: "BRYAN", q: "pizza", first: 5) { totalCount nodes { name address city lastInspectionScore } } }
```

**Q9. Search by address**

The same `q` also matches addresses. Addresses are stored with a `\r\n` between street and city.

```graphql
{ facilities(county: "BRYAN", q: "hwy", first: 5) { totalCount nodes { name address city } } }
```

**Q10. Only facilities with a perfect score**

`minScore` keeps facilities whose latest score is `>=` the value (0-100). Facilities without a score are excluded.

```graphql
{ facilities(county: "BRYAN", minScore: 100, first: 5) { totalCount nodes { name lastInspectionScore } } }
```

**Q11. County plus minimum score**

```graphql
{ facilities(county: "BRYAN", minScore: 95, first: 5) { totalCount nodes { name county lastInspectionScore } } }
```

**Q12. Combine every filter**

Filters combine with AND.

```graphql
{ facilities(city: "RICHMOND HILL", q: "pizza", minScore: 90, first: 5) {
  totalCount
  nodes { name address city lastInspectionScore }
} }
```

**Q13. Order: newest inspection first**

Results are sorted by `lastInspectionDate` descending; facilities never inspected come last.

```graphql
{ facilities(county: "BRYAN", first: 10) { nodes { name lastInspectionDate } } }
```

**Q14. Next page with a cursor**

Pagination is forward-only. Pass the previous page's `pageInfo.endCursor` as `after`.

Request 1:

```graphql
{ facilities(county: "BRYAN", first: 3) { pageInfo { endCursor } nodes { id name lastInspectionDate } } }
```

Request 2:

```graphql
query Next($county: String, $after: String) {
  facilities(county: $county, first: 3, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id name county lastInspectionDate }
  }
}
```

Variables:

```json
{"county":"BRYAN","after":"<endCursor from the previous page>"}
```

**Q15. Walk every page of a small county**

Repeat the request while `hasNextPage` is true. The ids collected equal `totalCount`.

```graphql
query Page($county: String, $after: String) {
  facilities(county: $county, first: 25, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes { id }
  }
}
```

Variables:

```json
{"county":"APPLING","after":null}
```

Repeat while `pageInfo.hasNextPage` is true, sending `endCursor` back as `after`.

**Q16. Count only**

Selecting only `totalCount` is the cheapest way to size a result set.

```graphql
{ facilities(county: "BRYAN", minScore: 90) { totalCount } }
```

**Q17. No matches is an empty page, not an error**

```graphql
{ facilities(q: "zzz-no-such-place") { totalCount nodes { id } pageInfo { hasNextPage endCursor } } }
```

**Q18. Facilities whose history is still syncing**

`historyPending` is true while a facility's inspection history has not been fully synced yet.

```graphql
{ facilities(county: "BRYAN", first: 5) { nodes { name historyPending updatedAt } } }
```

</details>

<details>
<summary><b>GraphQL features</b> (Q19-Q24)</summary>

**Q19. Aliases: two counties in one request**

```graphql
{
  first: facilities(county: "BRYAN", first: 1) { totalCount nodes { name } }
  second: facilities(county: "APPLING", first: 1) { totalCount nodes { name } }
}
```

**Q20. Fragments**

```graphql
{
  facilities(county: "BRYAN", first: 2) { nodes { ...Card } }
}
fragment Card on Facility { name city lastInspectionScore lastInspectionDate }
```

**Q21. Variables with default values**

```graphql
query Browse($county: String = "BRYAN", $n: Int = 3) {
  facilities(county: $county, first: $n) { nodes { name } }
}
```

**Q22. @include and @skip**

```graphql
query Card($full: Boolean!) {
  facilities(county: "BRYAN", first: 2) {
    nodes { name address @include(if: $full) phone @skip(if: $full) }
  }
}
```

Variables:

```json
{"full":true}
```

**Q23. Several operations in one document**

Send `operationName` to pick one; without it the server answers `OPERATION_RESOLUTION_FAILURE` (HTTP 400).

```graphql
query Names { counties }
query Ping { __typename }
```

Send `"operationName": "Ping"`.

**Q24. Several root fields in one round trip**

```graphql
{
  counties
  facility(id: "OTQ5MDk0Mw==") { name }
  inspection(id: "99524328") { inspectionDate score }
}
```

</details>

<details>
<summary><b>Facility and inspections</b> (Q25-Q30)</summary>

**Q25. One facility by id**

The id is the portal facility id (take it from any `facilities` result). Unknown ids return `null`.

```graphql
{ facility(id: "OTQ5MDk0Mw==") { id name address city county permitType permitNumber phone lastInspectionScore lastInspectionDate historyPending updatedAt } }
```

**Q26. A facility with its latest inspections**

```graphql
{ facility(id: "OTQ5MDk0Mw==") {
  name
  inspections(first: 2) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes { id inspectionDate purpose score inspector }
  }
} }
```

**Q27. Page through a facility's inspections**

Inspections are newest first and paginate like facilities.

Request 1:

```graphql
{ facility(id: "OTQ5MDk0Mw==") { inspections(first: 1) { pageInfo { endCursor } nodes { id inspectionDate } } } }
```

Request 2:

```graphql
query More($id: ID!, $after: String) {
  facility(id: $id) { inspections(first: 1, after: $after) { pageInfo { hasNextPage } nodes { id inspectionDate } } }
}
```

Variables:

```json
{"id":"OTQ5MDk0Mw==","after":"<endCursor from the previous page>"}
```

**Q28. How many inspections does a facility have?**

```graphql
{ facility(id: "OTQ5MDk0Mw==") { name inspections(first: 1) { totalCount } } }
```

**Q29. The deepest allowed query: facility to violation**

Depth 8 is the limit: `facilities > edges > node > inspections > edges > node > violations > code`. `minScore: 0` keeps only facilities that have been scored, so each has inspections.

```graphql
{ facilities(county: "BRYAN", minScore: 0, first: 2) {
  edges { node { name inspections(first: 2) { edges { node { inspectionDate violations { code } } } } } }
} }
```

**Q30. Unknown facility returns null**

```graphql
{ facility(id: "does-not-exist") { id name } }
```

</details>

<details>
<summary><b>Inspections and violations</b> (Q31-Q34)</summary>

**Q31. One inspection with its violations**

`violations` is a plain list; `points`, `correctedOnSite` and `repeat` are as reported by the portal. Note the score is not always 100 minus the points.

```graphql
{ inspection(id: "99524328") {
  id inspectionDate purpose score inspector reportUrl
  violations { id code ruleCitation points correctedOnSite repeat notes }
} }
```

**Q32. From an inspection back to its facility**

```graphql
{ inspection(id: "99524328") { score facility { id name city } } }
```

**Q33. Latest score matches the facility's score**

`lastInspectionScore` on the facility is the score of its newest inspection.

```graphql
{ facility(id: "OTQ5MDk0Mw==") {
  lastInspectionScore
  lastInspectionDate
  inspections(first: 1) { nodes { score inspectionDate } }
} }
```

**Q34. Unknown inspection returns null**

```graphql
{ inspection(id: "does-not-exist") { id } }
```

</details>

<details>
<summary><b>Data freshness (sync)</b> (Q35-Q39)</summary>

**Q35. Most recent sync runs**

One run per county per sync, newest first. `limit` is 1-50.

```graphql
{ syncRuns(limit: 3) { id county status startedAt finishedAt } }
```

**Q36. Sync runs of one county**

```graphql
{ syncRuns(county: "BRYAN", limit: 3) { id county status finishedAt } }
```

**Q37. Successful runs with their counters**

`result` is JSON: pages walked, facilities seen/upserted, inspections and violations upserted, new watermark.

```graphql
{ syncRuns(status: ok, limit: 2) { county status result } }
```

**Q38. Failed or interrupted runs**

`status` is an enum: `running`, `ok`, `failed`, `interrupted`. An empty list is the good answer.

```graphql
{ failed: syncRuns(status: failed, limit: 5) { county error } interrupted: syncRuns(status: interrupted, limit: 5) { county } }
```

**Q39. How fresh is the data?**

`running` lists syncs in progress; `lastSuccessAt` is the most recent successful run of any county.

```graphql
{ syncStatus { lastSuccessAt running { county startedAt } lastRuns(limit: 2) { county status } } }
```

</details>

<details>
<summary><b>Errors and limits</b> (Q40-Q49)</summary>

**Q40. Page size 0 is rejected**

`first` must be 1-100. Out-of-range values are rejected (`BAD_USER_INPUT`), not clamped.

```graphql
{ facilities(first: 0) { totalCount } }
```

**Q41. Page size 101 is rejected**

```graphql
{ facilities(first: 101) { totalCount } }
```

**Q42. Invalid cursor**

```graphql
{ facilities(after: "not-a-cursor") { totalCount } }
```

**Q43. Score out of range**

```graphql
{ facilities(minScore: 150) { totalCount } }
```

**Q44. Search text too long**

```graphql
{ facilities(q: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") { totalCount } }
```

**Q45. Sync run limit out of range**

```graphql
{ syncRuns(limit: 0) { id } }
```

**Q46. Unknown field (HTTP 400)**

Validation errors come back with HTTP 400 and `GRAPHQL_VALIDATION_FAILED`.

```graphql
{ facilities(first: 1) { nodes { nope } } }
```

**Q47. Too deep (HTTP 400)**

Depth limit 8. This query reaches 11 and is rejected with `QUERY_TOO_DEEP`.

```graphql
{ facilities(first: 1) { edges { node { inspections(first: 1) { edges { node {
  facility { inspections(first: 1) { edges { node { id } } } }
} } } } } } }
```

**Q48. Too expensive (HTTP 400)**

Cost limit 10,000 (`first` multiplies the cost of everything below it). Rejected with `QUERY_TOO_COMPLEX`; ask for smaller pages.

```graphql
{ facilities(first: 100) { nodes { inspections(first: 100) { nodes { violations { code points notes } } } } } }
```

**Q49. There are no mutations**

The API is read-only. The schema has no `Mutation` or `Subscription` type (the first request needs introspection), and a mutation is rejected with HTTP 400 and `OPERATION_NOT_SUPPORTED`.

Request 1:

```graphql
{ __schema { mutationType { name } subscriptionType { name } } }
```

Request 2:

```graphql
mutation { anything }
```

</details>

<!-- queries:end -->

## Run manually

Everything below was executed on a Mac with Docker 29 and Node 24. Another Postgres already held
port 5432, so compose publishes on `PG_PORT` (default 5432); here 5433.

Install, build, check:

```
npm ci
npm run typecheck && npm run lint && npm run build
npm run schema:check        # -> schema.graphql is up to date
```

Start Postgres, migrate, test:

```
PG_PORT=5433 docker compose up -d --wait postgres
export DATABASE_URL=postgresql://gafood:gafood@localhost:5433/gafood
npx prisma migrate deploy   # -> All migrations have been successfully applied.
npm test                    # -> Test Files 7 passed (7), Tests 64 passed (64)
```

Run the built image on the compose network (separate database `imgtest`):

```
docker build -t food-service:local .
docker exec <postgres-container> createdb -U gafood imgtest
U='postgresql://gafood:gafood@postgres:5432/imgtest'
N=<compose project>_default

# migrate (as the PreSync hook does), uid 1000
docker run --network $N --user 1000 -e DATABASE_URL=$U \
  --entrypoint node_modules/.bin/prisma food-service:local migrate deploy
# -> migrations/20261030165359_init ... All migrations have been successfully applied.

# sync one county from the live portal, read-only root filesystem (about 75 s)
docker run --network $N --user 1000 --read-only --tmpfs /tmp -e DATABASE_URL=$U \
  -e SYNC_COUNTIES=LONG --entrypoint node food-service:local dist/ingest.js
# [sync] starting county=LONG
# [sync] done county=LONG {"pagesWalked":8,"facilitiesSeen":38,"facilitiesUpserted":38,
#   "inspectionsUpserted":165,"violationsUpserted":81,"historiesPending":0,"newWatermark":"2026-10-20"}
# [sync] finished: 1/1 counties ok

# server
docker run --network $N --user 1000 --read-only --tmpfs /tmp -p 8081:8080 -e DATABASE_URL=$U \
  -e PORT=8080 -e GRAPHQL_INTROSPECTION=true food-service:local
# {"msg":"listening","port":8080,"introspection":true,"metrics":false,"traces":false}
```

Query it:

```
curl -s localhost:8081/health/liveness    # HTTP 200
curl -s localhost:8081/health/readiness   # {"status":"UP"}
curl -s -H 'content-type: application/json' localhost:8081/graphql \
  --data '{"query":"{ facilities(county: \"LONG\", first: 2) { totalCount nodes { name city lastInspectionScore lastInspectionDate } } }"}'
# {"data":{"facilities":{"totalCount":38,"nodes":[{"name":"Antojitos Latinosy Taqueria","city":"GLENNVILLE","lastInspectionScore":95,...},{"name":"Genesis Cafe","city":"LUDOWICI","lastInspectionScore":100,...}]}}}
curl -s -H 'content-type: application/json' localhost:8081/graphql --data '{"query":"{ counties }"}'
# {"data":{"counties":["APPLING","ATKINSON","BACON","BAKER","BALDWIN",...
```

Stop Postgres afterwards with `docker compose down` (add `-v` to also drop the data volume).

## Configuration

Environment variables read by the app (see [.env.example](.env.example)):

- `DATABASE_URL` - Postgres connection string. On GKE it is assembled from the Crossplane `cloudsql-connection` secret and the ExternalSecret credentials.
- `PORT` - HTTP port of the server (8080).
- `GRAPHQL_INTROSPECTION` - `true`/`false` overrides the default (introspection off when `NODE_ENV=production`); on in the dev cluster, which sits behind the allowlist.
- `GRAPHQL_SANDBOX` - `true`/`false` (default `false`): serve the embedded Apollo Sandbox at `GET /graphql` for browser testing; needs introspection. On in the dev cluster; open `https://graphql.miqui.dev/graphql` from an allowlisted IP.
- `OTEL_METRICS_URL` - OTLP/HTTP metrics endpoint for the sync job (falls back to `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/metrics`). A failed push never fails the job.
- `OTEL_TRACES_URL` - OTLP/HTTP traces endpoint for the server; `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` set sampling (10% on GKE).
- `SYNC_COUNTIES` - comma-separated upper-case county names for the ingest (multi-word allowed, e.g. `BEN HILL`); unset means all 159.

Sync metrics (same names in `src/ingest/metrics.ts`, the Prometheus rules and the Grafana "Food Sync" dashboard):
`sync_runs_total{county,status}`, `sync_last_success_timestamp_seconds{county}`, `sync_duration_seconds`
(histogram), `facilities_upserted_total{county}`. Alerts: `FoodSyncStale` (no success for 36 h) and `FoodSyncJobFailed`.

## CronJob behaviour

- `food-sync` runs daily at 03:00 UTC (`node dist/ingest.js`) with `SYNC_COUNTIES=LONG,MCINTOSH,LIBERTY` (ConfigMap `food-sync-config`).
- It is incremental: a per-county watermark skips unchanged facilities, and facilities whose history was not fully fetched are retried on the next run.
- Widen the sync by editing `SYNC_COUNTIES` in [k8s/configmap.yaml](k8s/configmap.yaml) (comma-separated) and merging; the next run picks it up. Leaving it unset syncs all 159 counties, which takes far longer and is heavier on the portal.
- Manual run: `kubectl create job --from=cronjob/food-sync food-sync-manual-1` (see [docs/DEPLOY.md](docs/DEPLOY.md)).

## Deploy to GKE

See [docs/DEPLOY.md](docs/DEPLOY.md). Only one stack runs on the dev cluster at a time: tear the previous stack
down first with `./gke-teardown.sh`, then run `gke-deploy.sh` -> `gke-secrets-seed.sh` -> `gke-bootstrap.sh`.

One-time manual step: the Workload Identity binding that lets this repo's `main` push images to Artifact Registry,
plus the repo variables `GCP_WIF_PROVIDER` and `GCP_CI_SA` (section "Authorize the GitHub repo for image pushes" in docs/DEPLOY.md).

## Production checklist

The dev setup deliberately skips all of these; do them before treating this as production:

- Private subnets across at least 3 availability zones.
- Database ingress restricted to the application security group only.
- Automated backups with at least 7 days of retention (dev has none).
- Deletion protection on the database.
- A read replica for the API.
- Tune the Cloud Armor allowlist (it is the only access control today).
- Add authentication/authorization before opening the API publicly.
- Secrets rotation for DB, Grafana and OpenObserve credentials.

## Known limitations

- Portal coverage gaps: Gwinnett, Newton, Rockdale and Quitman counties are not fully served by the state portal, so expect little or no data there.
- The portal may rate-limit or block the NAT egress IP; a blocked run fails and `FoodSyncStale` fires after 36 h.
- `npm audit --omit=dev` reports 3 high findings, one chain: `prisma` CLI -> `@prisma/config` -> `deepmerge-ts` (stack exhaustion on recursive objects). Only the CLI config loader is affected, not the request path; the fix is the Prisma 7 major upgrade. CI runs the audit as non-blocking.
- `food-service:latest` in `k8s/` is a placeholder image reference; the audit-only `disallow-latest-tag` policy reports it.
- Nothing has been run on a real cluster (see below).

## Verification status

Verified locally (real runs on a Mac with Docker):

- `npm ci`, typecheck, lint, build, `schema:check`; `npm test` 64/64 against compose Postgres.
- Docker image builds; hadolint clean; contains `dist/index.js`, `dist/ingest.js` and the prisma CLI; runs as uid 1000 with a read-only root filesystem.
- `prisma migrate deploy` inside the image; `node dist/ingest.js` against the live portal (LONG: 38 facilities, 165 inspections, 81 violations); the server container answers `/health/*` and GraphQL queries.
- `kubectl kustomize` renders for all 7 kustomization directories; kubeconform strict on `k8s` and `k8s/observability` (CRD kinds skipped, 0 invalid).
- Kyverno CLI 1.19.1 via `check-policies.sh`: enforce policies pass for the Deployment, CronJob and migrate Job pods; the violating Deployment and CronJob fixtures are rejected.
- shellcheck clean on all scripts; `promtool check rules` and `check config --syntax-only` pass.

NOT verified (needs a real cluster or cloud account): Argo CD sync and PreSync hook ordering, Crossplane/Cloud SQL
provisioning, ExternalSecrets, Gateway/Cloud Armor, NetworkPolicy behaviour (including egress to the portal),
the CronJob on its schedule, OTLP delivery to the collector, alerts firing, the WIF image push, and Kyverno admission in-cluster.
