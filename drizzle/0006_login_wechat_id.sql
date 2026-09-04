ALTER TABLE "users" RENAME COLUMN "email" TO "wechat_id";
--> statement-breakpoint
ALTER INDEX "idx_users_email" RENAME TO "idx_users_wechat_id";
--> statement-breakpoint
COMMENT ON COLUMN "users"."wechat_id" IS '登录微信号';
