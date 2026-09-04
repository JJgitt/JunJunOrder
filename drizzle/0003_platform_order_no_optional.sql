DROP INDEX IF EXISTS "idx_orders_platform_order_no";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_orders_platform_order_no" ON "purchase_orders" USING btree ("platform","platform_order_no") WHERE "platform_order_no" <> '';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."platform_order_no" IS '采购平台订单号（选填，同一平台内非空值唯一）';
