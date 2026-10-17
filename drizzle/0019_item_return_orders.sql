ALTER TABLE order_items ADD COLUMN returned_qty integer NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD CONSTRAINT order_items_returned_qty_check CHECK (returned_qty >= 0 AND returned_qty <= qty);
ALTER TABLE purchase_orders ADD COLUMN return_source_order_id text REFERENCES purchase_orders(id);
ALTER TABLE purchase_orders ADD COLUMN return_source_item_id text REFERENCES order_items(id);
ALTER TABLE purchase_orders ADD COLUMN return_quantity integer;
ALTER TABLE purchase_orders ADD CONSTRAINT orders_return_source_check CHECK (
  (return_source_order_id IS NULL AND return_source_item_id IS NULL AND return_quantity IS NULL)
  OR (return_source_order_id IS NOT NULL AND return_source_item_id IS NOT NULL AND return_quantity IS NOT NULL
      AND return_quantity > 0 AND return_source_order_id <> id)
);
CREATE INDEX idx_orders_return_source_item ON purchase_orders(return_source_item_id);
COMMENT ON COLUMN order_items.returned_qty IS '该商品行已拆出生成回流新单的累计件数，不改变原采购与发货数量';
COMMENT ON COLUMN purchase_orders.return_source_order_id IS '商品回流新单的原订单，管理员可追溯；此类新单不重复计入看板采购额';
COMMENT ON COLUMN purchase_orders.return_source_item_id IS '商品回流新单对应的原商品行，防止来源被删除';
COMMENT ON COLUMN purchase_orders.return_quantity IS '本次从原商品行拆出的件数，创建后保留用于回流追溯';
