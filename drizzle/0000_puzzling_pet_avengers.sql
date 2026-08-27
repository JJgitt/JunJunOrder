CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"detail_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"sku" text NOT NULL,
	"size" text NOT NULL,
	"title" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_sku_size_pk" PRIMARY KEY("sku","size")
);
--> statement-breakpoint
CREATE TABLE "inventory_lots" (
	"order_id" text PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"size" text NOT NULL,
	"qty" integer NOT NULL,
	"location" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"shipped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"sku" text NOT NULL,
	"size" text NOT NULL,
	"change_qty" integer NOT NULL,
	"type" text NOT NULL,
	"location" text,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_images" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"object_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"platform_order_no" text NOT NULL,
	"title" text NOT NULL,
	"sku" text NOT NULL,
	"size" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"amount_cents" integer NOT NULL,
	"courier_no" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '待审核' NOT NULL,
	"reject_reason" text,
	"purchaser_id" text NOT NULL,
	"auditor_id" text,
	"received_at" timestamp with time zone,
	"location" text,
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
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'buyer' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_order_id_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_order_id_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_images" ADD CONSTRAINT "order_images_order_id_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_images" ADD CONSTRAINT "order_images_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_purchaser_id_users_id_fk" FOREIGN KEY ("purchaser_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_auditor_id_users_id_fk" FOREIGN KEY ("auditor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_entity_created" ON "audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_inventory_lots_sku_size" ON "inventory_lots" USING btree ("sku","size");--> statement-breakpoint
CREATE INDEX "idx_movements_sku_size_created" ON "inventory_movements" USING btree ("sku","size","created_at");--> statement-breakpoint
CREATE INDEX "idx_order_images_order_id" ON "order_images" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_orders_platform_order_no" ON "purchase_orders" USING btree ("platform","platform_order_no");--> statement-breakpoint
CREATE INDEX "idx_orders_status_created" ON "purchase_orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_orders_purchaser_created" ON "purchase_orders" USING btree ("purchaser_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_orders_courier_no" ON "purchase_orders" USING btree ("courier_no");--> statement-breakpoint
CREATE INDEX "idx_orders_sku_size" ON "purchase_orders" USING btree ("sku","size");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_email" ON "users" USING btree ("email");