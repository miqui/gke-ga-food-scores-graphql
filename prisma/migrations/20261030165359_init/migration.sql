-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('running', 'ok', 'failed', 'interrupted');

-- CreateTable
CREATE TABLE "facilities" (
    "id" SERIAL NOT NULL,
    "portal_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT '',
    "county" TEXT NOT NULL,
    "permit_type" TEXT NOT NULL,
    "permit_number" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "last_inspection_score" INTEGER,
    "last_inspection_date" DATE,
    "history_pending" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "facilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspections" (
    "id" SERIAL NOT NULL,
    "portal_id" TEXT NOT NULL,
    "facility_id" INTEGER NOT NULL,
    "inspection_date" DATE NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT '',
    "score" INTEGER,
    "inspector" TEXT NOT NULL DEFAULT '',
    "report_url" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "violations" (
    "id" SERIAL NOT NULL,
    "inspection_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "rule_citation" TEXT NOT NULL DEFAULT '',
    "points" INTEGER NOT NULL DEFAULT 0,
    "corrected_on_site" BOOLEAN NOT NULL DEFAULT false,
    "repeat" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "violations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_state" (
    "county" TEXT NOT NULL,
    "watermark" DATE,
    "last_synced_at" TIMESTAMPTZ(3),
    "resume_page" INTEGER,
    "resume_newest" DATE,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("county")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" SERIAL NOT NULL,
    "county" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "status" "SyncRunStatus" NOT NULL,
    "result" JSONB,
    "error" TEXT,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_lock" (
    "id" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "counties" JSONB NOT NULL,
    "acquired_at" TIMESTAMPTZ(3) NOT NULL,
    "heartbeat_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_lock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "facilities_portal_id_key" ON "facilities"("portal_id");

-- CreateIndex
CREATE INDEX "facilities_county_idx" ON "facilities"("county");

-- CreateIndex
CREATE INDEX "facilities_city_idx" ON "facilities"("city");

-- CreateIndex
CREATE INDEX "facilities_last_inspection_score_idx" ON "facilities"("last_inspection_score");

-- CreateIndex
CREATE INDEX "facilities_name_idx" ON "facilities"("name");

-- CreateIndex
CREATE UNIQUE INDEX "inspections_portal_id_key" ON "inspections"("portal_id");

-- CreateIndex
CREATE INDEX "inspections_facility_id_idx" ON "inspections"("facility_id");

-- CreateIndex
CREATE INDEX "inspections_inspection_date_idx" ON "inspections"("inspection_date");

-- CreateIndex
CREATE INDEX "violations_inspection_id_idx" ON "violations"("inspection_id");

-- CreateIndex
CREATE INDEX "sync_runs_started_at_idx" ON "sync_runs"("started_at");

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violations" ADD CONSTRAINT "violations_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
