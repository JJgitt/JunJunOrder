COMMENT ON COLUMN "users"."id" IS '用户唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "users"."email" IS '登录邮箱';
--> statement-breakpoint
COMMENT ON COLUMN "users"."name" IS '用户姓名';
--> statement-breakpoint
COMMENT ON COLUMN "users"."password_hash" IS '密码哈希';
--> statement-breakpoint
COMMENT ON COLUMN "users"."role" IS '用户角色：admin 管理员，buyer 采购员';
--> statement-breakpoint
COMMENT ON COLUMN "users"."active" IS '是否启用';
--> statement-breakpoint
COMMENT ON COLUMN "users"."created_at" IS '创建时间';
--> statement-breakpoint
COMMENT ON COLUMN "users"."updated_at" IS '更新时间';
--> statement-breakpoint

COMMENT ON COLUMN "purchase_orders"."id" IS '采购订单唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."platform" IS '采购平台';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."platform_order_no" IS '采购平台订单号';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."title" IS '商品名称';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."sku" IS '商品 SKU';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."size" IS '商品尺码或规格';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."qty" IS '采购数量';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."amount_cents" IS '采购金额，单位：分';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."courier_no" IS '采购包裹快递单号';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."status" IS '订单状态：待审核、在途、已入库、待发货、已发货或已驳回';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."reject_reason" IS '审核驳回原因';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."purchaser_id" IS '采购员用户标识';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."auditor_id" IS '审核人用户标识';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."received_at" IS '入库时间';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."location" IS '入库库位';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."resale_platform" IS '转售平台';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."resale_order_no" IS '转售平台订单号';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."sale_price_cents" IS '销售金额，单位：分';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."outbound_company" IS '发货物流公司';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."outbound_courier_no" IS '出库快递单号';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."shipped_at" IS '发货时间';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."created_at" IS '创建时间';
--> statement-breakpoint
COMMENT ON COLUMN "purchase_orders"."updated_at" IS '更新时间';
--> statement-breakpoint

COMMENT ON COLUMN "inventory"."sku" IS '商品 SKU';
--> statement-breakpoint
COMMENT ON COLUMN "inventory"."size" IS '商品尺码或规格';
--> statement-breakpoint
COMMENT ON COLUMN "inventory"."title" IS '商品名称';
--> statement-breakpoint
COMMENT ON COLUMN "inventory"."quantity" IS '当前库存数量';
--> statement-breakpoint
COMMENT ON COLUMN "inventory"."updated_at" IS '库存最后更新时间';
--> statement-breakpoint

COMMENT ON COLUMN "inventory_lots"."order_id" IS '对应采购订单唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_lots"."sku" IS '商品 SKU';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_lots"."size" IS '商品尺码或规格';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_lots"."qty" IS '入库批次数量';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_lots"."location" IS '库存所在库位';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_lots"."received_at" IS '入库时间';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_lots"."shipped_at" IS '出库时间，未出库时为空';
--> statement-breakpoint

COMMENT ON COLUMN "inventory_movements"."id" IS '库存流水唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_movements"."order_id" IS '对应采购订单唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_movements"."sku" IS '商品 SKU';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_movements"."size" IS '商品尺码或规格';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_movements"."change_qty" IS '库存变动数量，正数入库、负数出库';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_movements"."type" IS '变动类型：receive 入库、ship 出库、adjust 调整';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_movements"."location" IS '变动对应库位';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_movements"."actor_id" IS '操作人用户标识';
--> statement-breakpoint
COMMENT ON COLUMN "inventory_movements"."created_at" IS '创建时间';
--> statement-breakpoint

COMMENT ON COLUMN "order_images"."id" IS '订单图片唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "order_images"."order_id" IS '对应采购订单唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "order_images"."object_key" IS '文件存储对象键';
--> statement-breakpoint
COMMENT ON COLUMN "order_images"."file_name" IS '原始文件名';
--> statement-breakpoint
COMMENT ON COLUMN "order_images"."content_type" IS '文件 MIME 类型';
--> statement-breakpoint
COMMENT ON COLUMN "order_images"."size_bytes" IS '文件大小，单位：字节';
--> statement-breakpoint
COMMENT ON COLUMN "order_images"."uploaded_by" IS '上传人用户标识';
--> statement-breakpoint
COMMENT ON COLUMN "order_images"."created_at" IS '上传时间';
--> statement-breakpoint

COMMENT ON COLUMN "audit_logs"."id" IS '审计日志唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "audit_logs"."actor_id" IS '操作人用户标识';
--> statement-breakpoint
COMMENT ON COLUMN "audit_logs"."action" IS '操作动作';
--> statement-breakpoint
COMMENT ON COLUMN "audit_logs"."entity_type" IS '业务实体类型';
--> statement-breakpoint
COMMENT ON COLUMN "audit_logs"."entity_id" IS '业务实体唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "audit_logs"."detail_json" IS '操作详情 JSON';
--> statement-breakpoint
COMMENT ON COLUMN "audit_logs"."created_at" IS '创建时间';
