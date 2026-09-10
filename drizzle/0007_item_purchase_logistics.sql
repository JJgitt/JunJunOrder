ALTER TABLE "order_items" ADD COLUMN "purchase_courier_company" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "purchase_courier_no" text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE "order_items" AS item
SET "purchase_courier_company" = orders."courier_company",
    "purchase_courier_no" = orders."courier_no"
FROM "purchase_orders" AS orders
WHERE item."order_id" = orders."id";
--> statement-breakpoint
CREATE INDEX "idx_order_items_purchase_courier_no" ON "order_items" USING btree ("purchase_courier_no");
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."purchase_courier_company" IS '该商品采购包裹快递公司';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."purchase_courier_no" IS '该商品采购包裹快递单号';
