import { boolean, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "buyer"] }).notNull().default("buyer"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [uniqueIndex("idx_users_email").on(table.email)]);

export const purchaseOrders = pgTable("purchase_orders", {
  id: text("id").primaryKey(),
  platform: text("platform").notNull(),
  platformOrderNo: text("platform_order_no").notNull(),
  title: text("title").notNull(),
  sku: text("sku").notNull(),
  size: text("size").notNull(),
  qty: integer("qty").notNull().default(1),
  amountCents: integer("amount_cents").notNull(),
  courierNo: text("courier_no").notNull().default(""),
  status: text("status", { enum: ["待审核", "在途", "已入库", "待发货", "已发货", "已驳回"] }).notNull().default("待审核"),
  rejectReason: text("reject_reason"),
  purchaserId: text("purchaser_id").notNull().references(() => users.id),
  auditorId: text("auditor_id").references(() => users.id),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }),
  location: text("location"),
  resalePlatform: text("resale_platform"),
  resaleOrderNo: text("resale_order_no"),
  salePriceCents: integer("sale_price_cents"),
  outboundCompany: text("outbound_company"),
  outboundCourierNo: text("outbound_courier_no"),
  shippedAt: timestamp("shipped_at", { withTimezone: true, mode: "string" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  uniqueIndex("idx_orders_platform_order_no").on(table.platform, table.platformOrderNo),
  index("idx_orders_status_created").on(table.status, table.createdAt),
  index("idx_orders_purchaser_created").on(table.purchaserId, table.createdAt),
  index("idx_orders_courier_no").on(table.courierNo),
  index("idx_orders_sku_size").on(table.sku, table.size),
]);

export const inventory = pgTable("inventory", {
  sku: text("sku").notNull(),
  size: text("size").notNull(),
  title: text("title").notNull(),
  quantity: integer("quantity").notNull().default(0),
  updatedAt: updatedAt(),
}, (table) => [primaryKey({ columns: [table.sku, table.size] })]);

export const inventoryLots = pgTable("inventory_lots", {
  orderId: text("order_id").primaryKey().references(() => purchaseOrders.id),
  sku: text("sku").notNull(),
  size: text("size").notNull(),
  qty: integer("qty").notNull(),
  location: text("location").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }).notNull(),
  shippedAt: timestamp("shipped_at", { withTimezone: true, mode: "string" }),
}, (table) => [index("idx_inventory_lots_sku_size").on(table.sku, table.size)]);

export const inventoryMovements = pgTable("inventory_movements", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => purchaseOrders.id),
  sku: text("sku").notNull(),
  size: text("size").notNull(),
  changeQty: integer("change_qty").notNull(),
  type: text("type", { enum: ["receive", "ship", "adjust"] }).notNull(),
  location: text("location"),
  actorId: text("actor_id").notNull().references(() => users.id),
  createdAt: createdAt(),
}, (table) => [index("idx_movements_sku_size_created").on(table.sku, table.size, table.createdAt)]);

export const orderImages = pgTable("order_images", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => purchaseOrders.id),
  objectKey: text("object_key").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedBy: text("uploaded_by").notNull().references(() => users.id),
  createdAt: createdAt(),
}, (table) => [index("idx_order_images_order_id").on(table.orderId)]);

export const auditLogs = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  detailJson: text("detail_json").notNull().default("{}"),
  createdAt: createdAt(),
}, (table) => [index("idx_audit_entity_created").on(table.entityType, table.entityId, table.createdAt)]);
