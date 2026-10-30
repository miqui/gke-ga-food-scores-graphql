# Deploying gke-ga-food-scores-graphql to GKE

One dev cluster runs at a time. The GCP resource names are fixed and shared with the sibling
project `gke-graphql-apollo-prisma-o2` (`graphql-cluster`, `graphql-vpc`, `graphql-nat`,
`graphql-ip`, `graphql-allowlist`, `graphql-cert-map`, host `graphql.miqui.dev`, project
`k8s-dev-412419`, region `us-central1`, namespace `default`). **Tear down the previous stack first**
(`PROJECT_ID=k8s-dev-412419 ./gke-teardown.sh`), then deploy this one.

## Deploy order

1. `PROJECT_ID=k8s-dev-412419 ./gke-deploy.sh` - VPC, Cloud NAT, private GKE cluster, Cloud SQL
   private networking, Artifact Registry, service accounts, Workload Identity Federation for this
   repo, static IP, certificate map, Cloud Armor allowlist (defaults to the deploy machine's IP).
   Prints the DNS records and the two GitHub repository variables `GCP_WIF_PROVIDER` and
   `GCP_CI_SA` - set both under Settings -> Secrets and variables -> Actions -> Variables.
2. `op run --env-file=.env -- env PROJECT_ID=k8s-dev-412419 ./gke-secrets-seed.sh` - seeds Secret
   Manager from 1Password. Copy `.env.example` to `.env` first. The database secret is
   `gql-postgres-food-password`.
3. `PROJECT_ID=k8s-dev-412419 ./gke-bootstrap.sh` - installs Argo CD and the root Application;
   everything else syncs from `main` of this repo. The image must exist in Artifact Registry
   (merge to `main` once so `build-and-push.yml` has pushed `food-service`), otherwise the pods
   wait in `ImagePullBackOff` until it does.

Sync order (waves): controllers -> policies -> observability -> `graphql-db` (ExternalSecret +
Cloud SQL, ~10-15 min) -> `graphql-api` (PreSync Job `food-migrate` runs `prisma migrate deploy`,
then Deployment, HPA, PDB, Service, Gateway, CronJob `food-sync`).

## The food-sync CronJob

Runs daily at 03:00 UTC (`k8s/cronjob.yaml`), same image as the API with the command overridden to
`node dist/ingest.js`; it never starts the server or migrates.

Manual run:

```
kubectl create job --from=cronjob/food-sync food-sync-manual-1
kubectl logs -f job/food-sync-manual-1
```

Use a new job name each time. Manual jobs match the `food-sync*` alert selectors.

### Widen SYNC_COUNTIES

Edit one line in `k8s/configmap.yaml` (ConfigMap `food-sync-config`), commit, merge to `main`:

```
SYNC_COUNTIES: "LONG,MCINTOSH,LIBERTY"      # e.g. "LONG,MCINTOSH,LIBERTY,CHATHAM"
```

Argo CD applies it; the next run (or a manual run) uses it. Names are upper-case, comma-separated.

## Alerts and dashboard

Prometheus rules (`k8s/observability/config/rules/food-sync.rules.yml`): `FoodSyncStale` (no
`sync_last_success_timestamp_seconds` within 36h) and `FoodSyncJobFailed`
(`kube_job_status_failed{job_name=~"food-sync.*"} > 0`). There is no Alertmanager; read them in
the Prometheus UI (`./gke-port-forward.sh`, Alerts tab). Grafana dashboard: "Food Sync"
(uid `food-sync`).

## Authorize the GitHub repo for image pushes (WIF binding)

`gke-deploy.sh` already does this for `GITHUB_REPO` (default `miqui/gke-ga-food-scores-graphql`).
The Workload Identity pool/provider only admit tokens from `main` of repositories owned by
`miqui`. If the repo was created after the last `gke-deploy.sh` run, the owner runs the binding
once (replace `PROJECT_NUMBER` with the project number of `k8s-dev-412419`):

```
gcloud iam service-accounts add-iam-policy-binding \
  ci-graphql-apollo-prisma-o2@k8s-dev-412419.iam.gserviceaccount.com \
  --project=k8s-dev-412419 \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/miqui/gke-ga-food-scores-graphql"
```

Then set the repository variables `GCP_WIF_PROVIDER`
(`projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-oidc`) and
`GCP_CI_SA` (`ci-graphql-apollo-prisma-o2@k8s-dev-412419.iam.gserviceaccount.com`).

## Runtime contract (for the application)

- HTTP on 8080; `/health/liveness`, `/health/readiness`; GraphQL at `/graphql`.
- `DATABASE_URL` is composed in the pod from `cloudsql-connection` (`privateIP`) and the
  `food-service-db-credentials` Secret (`DB_USER`, `DB_PASSWORD_URLENC`), `sslmode=require`.
- Image entrypoint `node dist/index.js`; CronJob command `node dist/ingest.js`; migrations by
  `node_modules/.bin/prisma migrate deploy` in the PreSync hook.
- Telemetry: OTLP/HTTP to `http://otel-collector.observability.svc.cluster.local:4318`
  (`OTEL_METRICS_URL`, `OTEL_TRACES_URL`). Sync metrics: `sync_runs_total{county,status}`,
  `sync_last_success_timestamp_seconds{county}`, `sync_duration_seconds` (histogram),
  `facilities_upserted_total{county}`.
