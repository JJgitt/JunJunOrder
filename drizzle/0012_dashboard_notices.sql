CREATE TABLE "dashboard_notices" (
  "id" text PRIMARY KEY NOT NULL,
  "content" text NOT NULL,
  "completed" boolean DEFAULT false NOT NULL,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "dashboard_notices_content_nonempty" CHECK (length(trim("content")) > 0)
);

CREATE INDEX "idx_dashboard_notices_created" ON "dashboard_notices" ("created_at");
COMMENT ON TABLE "dashboard_notices" IS '管理员看板注意事项清单';
COMMENT ON COLUMN "dashboard_notices"."id" IS '注意事项唯一标识';
COMMENT ON COLUMN "dashboard_notices"."content" IS '注意事项内容';
COMMENT ON COLUMN "dashboard_notices"."completed" IS '是否完成';
COMMENT ON COLUMN "dashboard_notices"."created_by" IS '创建管理员 ID';
COMMENT ON COLUMN "dashboard_notices"."created_at" IS '创建时间';
COMMENT ON COLUMN "dashboard_notices"."updated_at" IS '最后更新时间';
