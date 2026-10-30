# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for the food-service Apollo Server + Prisma GraphQL API.
#
# One image, two roles:
#   - food-service Deployment: the default ENTRYPOINT `node dist/index.js` (HTTP server only)
#   - food-sync CronJob:       `command: ["node", "dist/ingest.js"]` overrides the entrypoint
# Schema migrations are NOT run at startup: the Argo CD PreSync hook Job (k8s/migrate-job.yaml)
# runs `prisma migrate deploy` once per sync, using the Prisma CLI installed as a production
# dependency below.
#
# Layout expected: package.json + package-lock.json at the repo root, prisma/schema.prisma (and
# optionally prisma.config.ts), src/ compiled by `npm run build` into dist/index.js (server) and
# dist/ingest.js (sync CLI).

# Shared base. Prisma's query engine binary needs openssl on Alpine (musl) - without it
# `generate` picks the wrong engine and the app fails at runtime with "Unable to require
# libquery_engine".
FROM node:24-alpine AS base
RUN apk add --no-cache openssl

# Stage 1: build (full deps + TypeScript compile)
FROM base AS builder
WORKDIR /workspace

# Only the manifests and schema are needed to install and generate the client, so editing src/
# doesn't invalidate the npm ci layer. `prisma.config.t[s]` is a glob that is allowed to match
# nothing (package.json always matches), so the file stays optional.
COPY package.json package-lock.json prisma.config.t[s] ./
COPY prisma/ prisma/
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Stage 2: production dependencies only (includes the prisma CLI used by the migrate hook).
FROM base AS prod-deps
WORKDIR /app
COPY package.json package-lock.json prisma.config.t[s] ./
COPY prisma/ prisma/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev && npx prisma generate

# Stage 3: runtime
FROM base
WORKDIR /app

ENV NODE_ENV=production

# COPY --chown avoids a `chown -R` layer that would duplicate all of node_modules.
COPY --chown=node:node package.json prisma.config.t[s] ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node prisma/ prisma/
COPY --chown=node:node --from=builder /workspace/dist ./dist

# The built-in non-root user (uid 1000). The Kubernetes manifests also set runAsUser: 1000.
USER node
EXPOSE 8080

# Server only. `exec` form: node is PID 1 and receives SIGTERM for graceful shutdown.
ENTRYPOINT ["node", "dist/index.js"]
