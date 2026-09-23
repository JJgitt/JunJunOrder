CREATE TABLE "product_knowledge" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "sku" text NOT NULL,
  "aliases" text DEFAULT '[]' NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "source_order_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "idx_product_knowledge_title_sku" ON "product_knowledge" ("title", "sku");
CREATE INDEX "idx_product_knowledge_sku" ON "product_knowledge" ("sku");

-- Only previously approved, human-reviewed order items with a non-fallback SKU enter the first catalog.
INSERT INTO "product_knowledge" ("id", "title", "sku", "source", "source_order_id")
SELECT 'pk_' || replace(gen_random_uuid()::text, '-', ''), candidate."title", candidate."sku", 'historical', candidate."order_id"
FROM (
  SELECT DISTINCT ON (trim(item."title"), trim(item."sku"))
    trim(item."title") AS "title", trim(item."sku") AS "sku", item."order_id"
  FROM "order_items" item
  JOIN "purchase_orders" purchase ON purchase."id" = item."order_id"
  WHERE purchase."status" NOT IN ('待审核', '已驳回')
    AND length(trim(item."title")) >= 4
    AND length(trim(item."sku")) >= 2
    AND lower(trim(item."sku")) <> lower(trim(item."title"))
  ORDER BY trim(item."title"), trim(item."sku"), item."order_id"
) candidate
ON CONFLICT ("title", "sku") DO NOTHING;

COMMENT ON TABLE "product_knowledge" IS '已审核订单提炼的商品资料及管理员维护的别名';
COMMENT ON COLUMN "product_knowledge"."id" IS '商品知识记录 ID';
COMMENT ON COLUMN "product_knowledge"."title" IS '标准商品名称';
COMMENT ON COLUMN "product_knowledge"."sku" IS '货号或已确认的规格描述';
COMMENT ON COLUMN "product_knowledge"."aliases" IS '其他名称 JSON 数组，由管理员维护';
COMMENT ON COLUMN "product_knowledge"."source" IS '资料来源：historical 历史候选仅建议、approved 新审核订单、manual 管理员确认';
COMMENT ON COLUMN "product_knowledge"."source_order_id" IS '首次学习来源的已审核采购单 ID，手工创建时为空';
COMMENT ON COLUMN "product_knowledge"."created_at" IS '创建时间';
COMMENT ON COLUMN "product_knowledge"."updated_at" IS '更新时间';
