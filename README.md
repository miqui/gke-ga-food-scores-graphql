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
