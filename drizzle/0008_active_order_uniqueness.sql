-- 同一渠道下，非空平台订单号仅允许存在一笔未驳回采购单。
-- 已驳回记录保留历史，但不占用订单号；重新提交时重新参与唯一校验。
DROP INDEX IF EXISTS "idx_orders_platform_order_no";
CREATE UNIQUE INDEX "idx_orders_platform_order_no"
  ON "purchase_orders" ("platform", "platform_order_no")
  WHERE "platform_order_no" <> '' AND "status" <> '已驳回';
