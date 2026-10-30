# gke-ga-food-scores-graphql

A GraphQL API (Apollo Server + Prisma + Postgres 16) serving Georgia restaurant food-inspection scores. It is adapted from a REST API and packaged for GitOps deployment to a dev GKE cluster.

Status: work in progress

## Sections (coming later)
- Architecture (TBD)
- Run manually (TBD)
- Deploy to GKE (TBD)
- Production checklist (TBD)

See [PROVENANCE.md](PROVENANCE.md) for origins.

## Deploying to GKE

See [docs/DEPLOY.md](docs/DEPLOY.md). One cluster at a time: tear down the previous stack first (`./gke-teardown.sh`), then `gke-deploy.sh` -> `gke-secrets-seed.sh` -> `gke-bootstrap.sh`.
