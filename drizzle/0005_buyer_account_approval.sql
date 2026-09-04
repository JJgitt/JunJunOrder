ALTER TABLE "users" ADD COLUMN "phone" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "approval_status" text DEFAULT 'approved' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reviewed_by" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reviewed_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_phone" ON "users" USING btree ("phone") WHERE "phone" <> '';
--> statement-breakpoint
CREATE INDEX "idx_users_approval_created" ON "users" USING btree ("approval_status","created_at");
--> statement-breakpoint
COMMENT ON COLUMN "users"."phone" IS '手机号';
--> statement-breakpoint
COMMENT ON COLUMN "users"."approval_status" IS '账号审批状态：pending 待审批，approved 已通过，rejected 未通过';
--> statement-breakpoint
COMMENT ON COLUMN "users"."reviewed_by" IS '审批管理员 ID';
--> statement-breakpoint
COMMENT ON COLUMN "users"."reviewed_at" IS '审批时间';
