-- 回流为独立历史标记，后续入库、发货、结款不清除，也不改变当前订单状态。
ALTER TABLE "purchase_orders" ADD COLUMN "is_returned" boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN "purchase_orders"."is_returned" IS '是否曾通过已发货整单回滚进入回流流程；默认否，成功回滚时置是，后续流转保留，仅管理员可见';

-- 仅依据成功提交的整单回滚审计补标；普通撤销入库不视为回流。
UPDATE "purchase_orders" AS orders
SET "is_returned" = true
WHERE EXISTS (
  SELECT 1 FROM "audit_logs" AS audit
  WHERE audit."entity_type" = 'purchase_order'
    AND audit."action" = 'rollback_shipped_order'
    AND audit."entity_id" = orders."id"
);
