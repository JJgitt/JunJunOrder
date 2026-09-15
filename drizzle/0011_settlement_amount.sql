-- 实际结款金额独立记录；历史已结款订单无法确认真实金额，因此保持为空。
ALTER TABLE "purchase_orders" ADD COLUMN "settled_amount_cents" integer;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_settled_amount_positive" CHECK ("settled_amount_cents" IS NULL OR "settled_amount_cents" > 0);

COMMENT ON COLUMN "purchase_orders"."settled_amount_cents" IS '实际结款金额，单位为分；历史未记录时为空';
