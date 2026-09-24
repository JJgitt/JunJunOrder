import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const tables = Object.fromEntries([
  "purchaseOrders", "users", "orderImages", "orderItems", "auditLogs", "inventory", "inventoryLots", "inventoryMovements", "dashboardNotices",
].map(name => [name, { name }]));
const admin = { id: "admin", name: "管理员", role: "admin", active: true, approvalStatus: "approved", phone: "", wechatId: "", createdAt: "2026-09-24" };
const order = { id: "order-1", platform: "淘宝", platformOrderNo: "", courierCompany: "顺丰", courierNo: "SF123", purchaserId: "admin", status: "已入库", receivedAt: "2026-09-23T00:00:00.000Z", location: "A1", settled: false, createdAt: "2026-09-22T00:00:00.000Z" };
const oldItems = [
  { id: "item-a", orderId: order.id, title: "同款甲", sku: "SKU-1", size: "M", qty: 2, amountCents: 1000, purchaseCourierCompany: "顺丰", purchaseCourierNo: "SF123", shippedAt: null },
  { id: "item-b", orderId: order.id, title: "同款乙", sku: "SKU-1", size: "M", qty: 3, amountCents: 1500, purchaseCourierCompany: "顺丰", purchaseCourierNo: "SF123", shippedAt: null },
];
const lots = oldItems.map(item => ({ itemId: item.id, orderId: order.id, sku: item.sku, size: item.size, qty: item.qty, location: "A1", receivedAt: order.receivedAt, shippedAt: null }));
const receivedMovements = oldItems.map(item => ({ id: `receive-${item.id}`, orderId: order.id, sku: item.sku, size: item.size, changeQty: item.qty, type: "receive", location: "A1", actorId: admin.id }));
const toInput = item => ({ id: item.id, title: item.title, sku: item.sku, size: item.size, qty: item.qty, amount: item.amountCents / 100, purchaseCourierCompany: item.purchaseCourierCompany, purchaseCourierNo: item.purchaseCourierNo });

async function updateOrder(items) {
  const operations = [];
  const movementRows = structuredClone(receivedMovements);
  const rows = new Map([
    [tables.purchaseOrders, [order]], [tables.users, [admin]], [tables.orderImages, []],
    [tables.orderItems, oldItems], [tables.auditLogs, []], [tables.inventory, [{ sku: "SKU-1", size: "M", title: "同款", quantity: 5 }]],
    [tables.inventoryLots, lots], [tables.dashboardNotices, []],
  ]);
  const query = {
    select: () => ({ from(table) {
      const result = rows.get(table);
      if (!result) throw new Error(`Unknown table: ${table?.name}`);
      const builder = {
        where() { return builder; }, orderBy() { return builder; }, for() { return builder; },
        limit(count) { return Promise.resolve(result.slice(0, count)); },
        then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
      };
      return builder;
    } }),
    update: table => ({ set: values => ({ where: () => {
      operations.push({ action: "update", table, values });
      return Promise.resolve();
    } }) }),
    delete: table => ({ where: () => {
      operations.push({ action: "delete", table });
      return Promise.resolve();
    } }),
    insert: table => ({ values: values => {
      operations.push({ action: "insert", table, values });
      if (table === tables.inventoryMovements) movementRows.push(values);
      return {
        onConflictDoUpdate: () => Promise.resolve(),
        then(resolve, reject) { return Promise.resolve().then(resolve, reject); },
      };
    } }),
  };
  const db = { ...query, transaction: fn => fn(query) };
  const modules = {
    "@/db": { getDb: () => db }, "@/db/schema": tables,
    "@/lib/auth": { assertSameOrigin: () => {}, requireAdmin: () => {}, requireAppUser: async () => admin, routeError: error => { throw error; } },
    "@/lib/file-storage": {}, "@/lib/server-time": { serverClock: () => ({ now: "2026-09-24T00:00:00.000Z", timeZone: "Asia/Shanghai" }) },
    "@/lib/time": { timestamp: value => Date.parse(value) },
  };
  const route = {};
  new Function("require", "exports", code)(id => modules[id] ?? require(id), route);
  const response = await route.POST(new Request("http://localhost/api/app", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "update-order", orderId: order.id, platform: order.platform, platformNo: "", items }),
  }));
  assert.equal(response.status, 200);
  assert.equal(operations.some(op => op.table === tables.inventoryMovements && op.action !== "insert"), false, "historical movements must remain append-only");
  assert.deepEqual(movementRows.slice(0, 2), receivedMovements, "other lines' received movements must not be rewritten");
  return { operations, movementRows };
}

test("removing one of two identical SKU/size lines appends only its lot reversal", async () => {
  const { operations, movementRows } = await updateOrder([toInput(oldItems[1])]);
  assert.equal(movementRows.length, 3);
  assert.deepEqual(movementRows[2], {
    id: movementRows[2].id, orderId: order.id, sku: "SKU-1", size: "M", changeQty: -2,
    type: "adjust", location: "A1", actorId: admin.id, createdAt: movementRows[2].createdAt,
  });
  assert.equal(operations.filter(op => op.table === tables.inventoryLots && op.action === "delete").length, 1);
});

test("editing one of two identical SKU/size lines keeps both original receipts and records the replacement", async () => {
  const changed = { ...toInput(oldItems[0]), sku: "SKU-2", qty: 4 };
  const { operations, movementRows } = await updateOrder([changed, toInput(oldItems[1])]);
  assert.equal(movementRows.length, 4);
  assert.deepEqual(movementRows.slice(2).map(({ sku, size, changeQty, type, location }) => ({ sku, size, changeQty, type, location })), [
    { sku: "SKU-1", size: "M", changeQty: -2, type: "adjust", location: "A1" },
    { sku: "SKU-2", size: "M", changeQty: 4, type: "receive", location: "A1" },
  ]);
  assert.equal(operations.filter(op => op.table === tables.inventoryLots && op.action === "update").length, 1);
});

test("editing display fields without stock changes does not fabricate stock movements", async () => {
  const changed = { ...toInput(oldItems[0]), title: "同款甲（改名）" };
  const { movementRows } = await updateOrder([changed, toInput(oldItems[1])]);
  assert.deepEqual(movementRows, receivedMovements);
});
