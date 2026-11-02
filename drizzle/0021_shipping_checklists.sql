CREATE TABLE shipping_checklists (
  id text PRIMARY KEY,
  title text NOT NULL,
  source_text text NOT NULL DEFAULT '',
  source_time_text text NOT NULL DEFAULT '',
  declared_total integer,
  items jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipping_checklists_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  CONSTRAINT shipping_checklists_source_check CHECK (char_length(source_text) <= 50000 AND char_length(source_time_text) <= 40),
  CONSTRAINT shipping_checklists_total_check CHECK (declared_total IS NULL OR declared_total BETWEEN 0 AND 20000000),
  CONSTRAINT shipping_checklists_items_check CHECK (CASE WHEN jsonb_typeof(items) = 'array' THEN jsonb_array_length(items) BETWEEN 1 AND 200 ELSE false END),
  CONSTRAINT shipping_checklists_version_check CHECK (version > 0)
);
CREATE INDEX idx_shipping_checklists_created ON shipping_checklists(created_at, id);
COMMENT ON TABLE shipping_checklists IS '管理员独立发货拣货清单，按批次持久化，不关联订单或库存';
COMMENT ON COLUMN shipping_checklists.id IS '发货清单唯一标识';
COMMENT ON COLUMN shipping_checklists.title IS '清单标题，1至100字';
COMMENT ON COLUMN shipping_checklists.source_text IS '首次导入的原始文案，保留供核对，最多50000字';
COMMENT ON COLUMN shipping_checklists.source_time_text IS '文案中的原始时间文本，不推断年份或时区';
COMMENT ON COLUMN shipping_checklists.declared_total IS '文案声明的合计件数，未提供时为空';
COMMENT ON COLUMN shipping_checklists.items IS '清单项数组：标识、货号、商品名、尺码、件数、备注和完成状态';
COMMENT ON COLUMN shipping_checklists.version IS '并发修改版本号，写入需匹配当前版本';
COMMENT ON COLUMN shipping_checklists.created_by IS '创建管理员，删除成员时置空';
COMMENT ON COLUMN shipping_checklists.updated_by IS '最后修改管理员，删除成员时置空';
COMMENT ON COLUMN shipping_checklists.created_at IS '清单创建时间';
COMMENT ON COLUMN shipping_checklists.updated_at IS '清单最后更新时间';
