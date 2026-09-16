ALTER TABLE "dashboard_notices" ADD COLUMN "notice_date" date;
UPDATE "dashboard_notices" SET "notice_date" = ("created_at" AT TIME ZONE 'Asia/Shanghai')::date;
ALTER TABLE "dashboard_notices" ALTER COLUMN "notice_date" SET NOT NULL;
COMMENT ON COLUMN "dashboard_notices"."notice_date" IS '事项日期，可由管理员编辑；历史数据取创建时的中国日期';
