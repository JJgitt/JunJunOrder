ALTER TABLE "purchase_orders" ADD COLUMN "courier_company" text DEFAULT '' NOT NULL;
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."courier_company" IS '采购包裹快递公司';
