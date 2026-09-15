-- 订单附件区分普通采购/入库图片与管理员上传的结款凭证。
ALTER TABLE "order_images" ADD COLUMN "kind" text DEFAULT 'order' NOT NULL;

ALTER TABLE "order_images" ADD CONSTRAINT "order_images_kind_check" CHECK ("kind" IN ('order', 'settlement'));

COMMENT ON COLUMN "order_images"."kind" IS '图片用途：order 为采购或入库附件，settlement 为结款凭证';
