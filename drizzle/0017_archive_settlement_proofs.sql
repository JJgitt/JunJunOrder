-- 回滚已发货采购单时保留结款凭证，仅归档其用途，避免继续作为当前结款截图展示。
ALTER TABLE "order_images" DROP CONSTRAINT "order_images_kind_check";

ALTER TABLE "order_images" ADD CONSTRAINT "order_images_kind_check"
  CHECK ("kind" IN ('order', 'settlement', 'settlement_archived'));

COMMENT ON COLUMN "order_images"."kind" IS '图片用途：order 为采购或入库附件，settlement 为当前结款凭证，settlement_archived 为已发货订单回滚后归档的历史结款凭证（仅管理员可读取）';
