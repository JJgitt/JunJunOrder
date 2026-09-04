CREATE TABLE "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"title" text NOT NULL,
	"sku" text NOT NULL,
	"size" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"amount_cents" integer NOT NULL,
	"resale_platform" text,
	"resale_order_no" text,
	"sale_price_cents" integer,
	"outbound_company" text,
	"outbound_courier_no" text,
	"shipped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_order_items_order_id" ON "order_items" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX "idx_order_items_sku_size" ON "order_items" USING btree ("sku","size");
--> statement-breakpoint
INSERT INTO "order_items" ("id","order_id","title","sku","size","qty","amount_cents","resale_platform","resale_order_no","sale_price_cents","outbound_company","outbound_courier_no","shipped_at","created_at","updated_at")
SELECT 'item_' || replace(gen_random_uuid()::text,'-',''),"id","title","sku","size","qty","amount_cents","resale_platform","resale_order_no","sale_price_cents","outbound_company","outbound_courier_no","shipped_at","created_at","updated_at" FROM "purchase_orders";
--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD COLUMN "item_id" text;
--> statement-breakpoint
UPDATE "inventory_lots" lot SET "item_id" = item."id" FROM "order_items" item WHERE item."order_id" = lot."order_id";
--> statement-breakpoint
DELETE FROM "inventory_lots" WHERE "item_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "inventory_lots" ALTER COLUMN "item_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory_lots" DROP CONSTRAINT "inventory_lots_pkey";
--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD PRIMARY KEY ("item_id");
--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_item_id_order_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
UPDATE "purchase_orders" SET "status" = '已入库' WHERE "status" IN ('待发货','已发货');
--> statement-breakpoint
DROP INDEX "idx_orders_sku_size";
--> statement-breakpoint
ALTER TABLE "purchase_orders" DROP COLUMN "title", DROP COLUMN "sku", DROP COLUMN "size", DROP COLUMN "qty", DROP COLUMN "amount_cents", DROP COLUMN "resale_platform", DROP COLUMN "resale_order_no", DROP COLUMN "sale_price_cents", DROP COLUMN "outbound_company", DROP COLUMN "outbound_courier_no", DROP COLUMN "shipped_at";
--> statement-breakpoint
COMMENT ON TABLE "order_items" IS '采购订单商品行';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."id" IS '商品行 ID';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."order_id" IS '所属采购订单 ID';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."title" IS '商品名称';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."sku" IS '货号';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."size" IS '尺码';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."qty" IS '数量';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."amount_cents" IS '该商品实付金额（分）';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."resale_platform" IS '二级销售平台';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."resale_order_no" IS '二级平台订单号';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."sale_price_cents" IS '预估售价（分）';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."outbound_company" IS '发货物流公司';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."outbound_courier_no" IS '发货快递单号';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."shipped_at" IS '发货时间';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."created_at" IS '创建时间';
--> statement-breakpoint
COMMENT ON COLUMN "order_items"."updated_at" IS '更新时间';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_lots"."item_id" IS '对应商品行 ID';
