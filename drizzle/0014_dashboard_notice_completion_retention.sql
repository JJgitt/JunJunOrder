ALTER TABLE "dashboard_notices" ADD COLUMN "completed_at" timestamp with time zone;

UPDATE "dashboard_notices"
SET "completed_at" = "updated_at"
WHERE "completed" = true AND "completed_at" IS NULL;

CREATE INDEX "idx_dashboard_notices_completed_at"
ON "dashboard_notices" ("completed_at")
WHERE "completed" = true;

COMMENT ON COLUMN "dashboard_notices"."completed_at" IS '事项被标记完成的时间；恢复未完成时清空，用于仅展示最近 7 天完成事项';
