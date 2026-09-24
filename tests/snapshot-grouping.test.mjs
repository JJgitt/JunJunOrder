import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

const tables = Object.fromEntries([
  "purchaseOrders", "users", "orderImages", "orderItems", "auditLogs", "inventory", "inventoryLots", "dashboardNotices",
].map(name => [name, { name }]));
const buyer = { id: "buyer", name: "采购员甲", role: "buyer", phone: "111", wechatId: "buyer-wx", active: true, approvalStatus: "approved" };
const otherBuyer = { id: "other", name: "采购员乙", role: "buyer", phone: "222", wechatId: "other-wx", active: true, approvalStatus: "approved" };
const admin = { id: "admin", name: "管理员甲", role: "admin", phone: "333", wechatId: "admin-wx", active: true, approvalStatus: "approved" };
const orders = [
  { id: "o2", purchaserId: "buyer", status: "已入库", platform: "淘宝", platformOrderNo: "p2", courierCompany: "快递", courierNo: "c2", settled: false, createdAt: "2026-09-22", location: "仓库B" },
  { id: "o1", purchaserId: "buyer", status: "已入库", platform: "淘宝", platformOrderNo: "p1", courierCompany: "快递", courierNo: "c1", settled: true, settledBy: "admin", createdAt: "2026-09-21" },
  { id: "o3", purchaserId: "other", status: "在途", platform: "淘宝", platformOrderNo: "p3", courierCompany: "快递", courierNo: "c3", settled: false, createdAt: "2026-09-20" },
];
const items = [
  { id: "i1", orderId: "o1", title: "甲", sku: "sku1", size: "M", qty: 1, amountCents: 1250, shippedAt: "2026-09-23", purchaseCourierCompany: "", purchaseCourierNo: "" },
  { id: "i2", orderId: "o2", title: "乙", sku: "sku2", size: "L", qty: 2, amountCents: 2500, shippedAt: null, purchaseCourierCompany: "顺丰", purchaseCourierNo: "new" },
  { id: "i3", orderId: "o3", title: "丙", sku: "sku3", size: "S", qty: 1, amountCents: 3000, shippedAt: null, purchaseCourierCompany: "", purchaseCourierNo: "" },
  { id: "i4", orderId: "o2", title: "丁", sku: "sku4", size: "XL", qty: 1, amountCents: 1500, shippedAt: "2026-09-23", purchaseCourierCompany: "", purchaseCourierNo: "" },
];
const images = [
  { id: "proof1", orderId: "o2", kind: "settlement", fileName: "proof.png", uploadedBy: "admin", createdAt: "t1" },
  { id: "image1", orderId: "o1", kind: "order", fileName: "one.png", uploadedBy: "buyer", createdAt: "t2" },
  { id: "image2", orderId: "o2", kind: "order", fileName: "two.png", uploadedBy: "buyer", createdAt: "t3" },
  { id: "ignored", orderId: "o2", kind: "other", fileName: "other.png", uploadedBy: "buyer", createdAt: "t4" },
  { id: "proof2", orderId: "o2", kind: "settlement", fileName: "proof2.png", uploadedBy: "admin", createdAt: "t5" },
  { id: "image3", orderId: "o2", kind: "order", fileName: "three.png", uploadedBy: "buyer", createdAt: "t6" },
];
const inventoryRows = [
  { sku: "a|b", title: "A", size: "c", quantity: 4 },
  { sku: "a", title: "B", size: "b|c", quantity: 2 },
  { sku: "missing", title: "C", size: "M", quantity: 0 },
];
const lotRows = [
  { sku: "a|b", size: "c", location: "库位二" },
  { sku: "a", size: "b|c", location: "库位一" },
  { sku: "a|b", size: "c", location: "库位二" },
  { sku: "a|b", size: "c", location: "库位三" },
];

function handler(user) {
  const data = new Map([
    [tables.purchaseOrders, orders], [tables.users, [admin, buyer, otherBuyer]], [tables.orderImages, images],
    [tables.orderItems, items], [tables.auditLogs, [{ entityId: "o1", orderId: "o1", createdAt: "approved" }]],
    [tables.inventory, inventoryRows], [tables.inventoryLots, lotRows], [tables.dashboardNotices, []],
  ]);
  const db = { select: () => ({ from(table) {
    let rows = data.get(table);
    if (!rows) throw new Error(`Unknown table: ${table?.name}`);
    const query = {
      where() { if (table === tables.purchaseOrders) rows = rows.filter(row => row.purchaserId === user.id); return query; },
      orderBy() { return query; },
      limit(n) { return Promise.resolve(rows.slice(0, n)); },
      then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
    };
    return query;
  } }) };
  const modules = {
    "@/db": { getDb: () => db },
    "@/db/schema": tables,
    "@/lib/auth": { requireAppUser: async () => user, routeError: error => { throw error; } },
    "@/lib/file-storage": {},
    "@/lib/server-time": { serverClock: () => ({ now: "2026-09-24T00:00:00.000Z", timeZone: "Asia/Shanghai" }) },
    "@/lib/time": { timestamp: value => Date.parse(value) },
  };
  const exports = {};
  new Function("require", "exports", code)(id => modules[id] ?? require(id), exports);
  return exports.GET(new Request("http://localhost/api/app"));
}

test("admin snapshot preserves order, image and stock grouping order", async () => {
  const response = await handler(admin);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.orders.map(order => order.id), ["o2", "o1", "o3"]);
  assert.deepEqual(data.orders[0].items.map(item => item.id), ["i2", "i4"]);
  assert.deepEqual(data.orders[0].images.map(image => image.id), ["image2", "image3"]);
  assert.deepEqual(data.orders[0].settlementProofs.map(image => image.id), ["proof1", "proof2"]);
  assert.equal(data.orders[0].status, "待发货");
  assert.equal(data.orders[0].amount, 40);
  assert.equal(data.orders[0].items[0].purchaseCourierNo, "new");
  assert.equal(data.orders[0].items[1].purchaseCourierNo, "c2");
  assert.equal(data.orders[1].status, "已发货");
  assert.equal(data.orders[1].approvedAt, "approved");
  assert.deepEqual(data.stock.map(row => row.locations), [["库位二", "库位三"], ["库位一"], []]);
});

test("buyer snapshot keeps role-specific fields and excludes other buyers", async () => {
  const response = await handler(buyer);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.orders.map(order => order.id), ["o2", "o1"]);
  assert.deepEqual(data.orders.map(order => order.status), ["已入库", "已入库"]);
  assert.deepEqual(data.orders[0].items.map(item => item.id), ["i2", "i4"]);
  assert.deepEqual(data.orders[0].images.map(image => image.id), ["image2", "image3"]);
  assert.equal("shipped" in data.orders[0].items[0], false);
  assert.equal("purchaserPhone" in data.orders[0], false);
  assert.equal("location" in data.orders[0], false);
  assert.deepEqual(data.stock, []);
  assert.deepEqual(data.notices, []);
  assert.deepEqual(data.users.map(person => person.id), ["buyer"]);
});
