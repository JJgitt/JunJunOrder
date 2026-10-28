ALTER TABLE purchase_orders ADD COLUMN admin_note text NOT NULL DEFAULT '';
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_admin_note_check CHECK (char_length(admin_note) <= 1000);
COMMENT ON COLUMN purchase_orders.admin_note IS '管理员内部订单备注，选填，最多1000字；仅管理员可编辑和查看';
