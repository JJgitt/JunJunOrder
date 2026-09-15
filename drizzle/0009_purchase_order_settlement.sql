-- 采购结款与发货是两条独立流程；订单入库后可结款，发货不会修改结款状态。
ALTER TABLE "purchase_orders" ADD COLUMN "settled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "settled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "settled_by" text;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_settled_by_users_id_fk" FOREIGN KEY ("settled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_orders_settled_received" ON "purchase_orders" USING btree ("settled", "received_at");
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."settled" IS '采购款结算状态，独立于发货状态';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."settled_at" IS '采购款结算时间';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."settled_by" IS '执行结款的管理员用户ID';
