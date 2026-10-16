import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as settlement from "../lib/order-settlement.ts";

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const code = compile(await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"));
const fileCode = compile(await readFile(new URL("../app/api/files/[id]/route.ts", import.meta.url), "utf8"));
const admin = { id: "admin", role: "admin", name: "管理员", wechatId: "admin", phone: "", active: true, approvalStatus: "approved" };
const buyer = { ...admin, id: "buyer", role: "buyer", name: "采购员", wechatId: "buyer" };
const stamp = "2026-10-01T08:00:00.000Z";

function fixture({ actor = admin, settled = true, status = "已入库", failAudit = false } = {}) {
  const names = ["purchaseOrders", "orderItems", "orderImages", "inventory", "inventoryLots", "inventoryMovements", "auditLogs", "users", "dashboardNotices", "productKnowledge"];
  const tables = Object.fromEntries(names.map(name => [name, new Proxy({ name }, {
    get: (target, key) => key === "name" ? target.name : { table: name, key },
  })]));
  const order = { id: "order-1", platform: "淘宝", platformOrderNo: "T123", purchaserId: buyer.id, auditorId: admin.id,
    courierCompany: "顺丰", courierNo: "SF-purchase", status, isReturned: false, rejectReason: null, receivedAt: stamp, location: "A1",
    settled, settledAt: settled ? stamp : null, settledBy: settled ? admin.id : null, settledAmountCents: settled ? 73400 : null,
    createdAt: stamp, updatedAt: stamp };
  const items = [2, 3].map((qty, index) => ({ id: `item-${index}`, orderId: order.id, title: `同款${index}`, sku: "SKU-SHARED", size: "M", qty,
    amountCents: qty * 100, purchaseCourierCompany: "京东", purchaseCourierNo: `JD${index}`, shippedAt: stamp,
    outboundCompany: "申通", outboundCourierNo: "STO123", resalePlatform: "得物", resaleOrderNo: `DW${index}`,
    salePriceCents: 99900, createdAt: stamp, updatedAt: stamp }));
  let state = Object.fromEntries(names.map(name => [name, []]));
  state.purchaseOrders = [order]; state.orderItems = items; state.users = [admin, buyer];
  state.inventory = [{ sku: "SKU-SHARED", size: "M", title: "别单同款", quantity: 7 }];
  state.inventoryLots = [
    ...items.map(item => ({ itemId: item.id, orderId: order.id, sku: item.sku, size: item.size, qty: item.qty, location: "A1", receivedAt: stamp, shippedAt: stamp })),
    { itemId: "other-item", orderId: "other-order", sku: "SKU-SHARED", size: "M", qty: 7, location: "B2", receivedAt: stamp, shippedAt: null },
  ];
  state.inventoryMovements = items.flatMap(item => [
    { id: `receive-${item.id}`, orderId: order.id, sku: item.sku, size: item.size, changeQty: item.qty, type: "receive", location: "A1", actorId: admin.id, createdAt: stamp },
    { id: `ship-${item.id}`, orderId: order.id, sku: item.sku, size: item.size, changeQty: -item.qty, type: "ship", location: "A1", actorId: admin.id, createdAt: stamp },
  ]);
  state.orderImages = ["order", "settlement", "settlement_archived"].map((kind, index) => ({ id: `image-${index}`, orderId: order.id, kind,
    objectKey: `orders/file-${index}.png`, fileName: `图${index}.png`, contentType: "image/png", sizeBytes: 4, uploadedBy: admin.id, createdAt: stamp }));
  const operations = [], locks = [], filesRead = [], filesRemoved = [];
  const orm = {
    eq: (column, value) => row => row[column.key] === value,
    and: (...predicates) => row => predicates.every(predicate => predicate(row)),
    or: (...predicates) => row => predicates.some(predicate => predicate(row)),
    inArray: (column, values) => row => values.includes(row[column.key]),
    isNull: column => row => row[column.key] == null,
    gte: (column, value) => row => row[column.key] >= value,
    desc: column => column, sql: () => { throw new Error("Rollback must not mutate shared stock with SQL"); },
  };
  const query = getState => ({
    select: projection => ({ from(table) {
      const predicates = []; let count = Infinity, locked = false;
      const values = () => {
        if (locked) locks.push(table.name);
        return getState()[table.name].filter(row => predicates.every(predicate => predicate(row))).slice(0, count).map(row => projection
          ? Object.fromEntries(Object.entries(projection).map(([key, column]) => [key, row[column.key]])) : structuredClone(row));
      };
      const builder = { where(predicate) { predicates.push(predicate); return builder; }, orderBy() { return builder; },
        for() { locked = true; return builder; }, limit(value) { count = value; return builder; },
        then(resolve, reject) { return Promise.resolve().then(values).then(resolve, reject); } };
      return builder;
    } }),
    update: table => ({ set: patch => ({ where: async predicate => {
      operations.push({ type: "update", table: table.name });
      for (const row of getState()[table.name].filter(predicate)) Object.assign(row, structuredClone(patch));
    } }) }),
    delete: table => ({ where: async predicate => {
      operations.push({ type: "delete", table: table.name }); getState()[table.name] = getState()[table.name].filter(row => !predicate(row));
    } }),
    insert: table => ({ values: async input => {
      operations.push({ type: "insert", table: table.name });
      if (failAudit && table === tables.auditLogs) throw new Error("deliberate audit failure");
      getState()[table.name].push(...structuredClone(Array.isArray(input) ? input : [input]));
    } }),
  });
  const db = { ...query(() => state), transaction: async callback => {
    const next = structuredClone(state); const result = await callback(query(() => next)); state = next; return result;
  } };
  const modules = {
    "@/db": { getDb: () => db }, "@/db/schema": tables, "drizzle-orm": orm,
    "@/lib/auth": {
      assertSameOrigin() {}, requireAppUser: async () => { if (!actor) throw new Response(null, { status: 401 }); return actor; },
      requireAdmin: user => { if (user.role !== "admin") throw new Response(null, { status: 403 }); },
      routeError: error => error instanceof Response ? error : Response.json({ error: error.message }, { status: 500 }),
    },
    "@/lib/server-time": { serverClock: () => ({ now: stamp, timeZone: "Asia/Shanghai" }) },
    "@/lib/time": { timestamp: value => Date.parse(value) }, "@/lib/order-settlement": settlement,
    "@/lib/file-storage": { uploadPath: key => `/uploads/${key}` },
    "node:fs/promises": {
      readFile: async path => { filesRead.push(path); return Buffer.from("file"); },
      unlink: async path => { filesRemoved.push(path); },
    },
  };
  const load = compiled => { const route = {}; new Function("require", "exports", compiled)(id => modules[id] ?? require(id), route); return route; };
  const route = load(code), files = load(fileCode);
  return { get state() { return state; }, operations, locks, filesRead, filesRemoved, login: user => { actor = user; },
    post: body => route.POST(new Request("http://localhost/api/app", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })),
    rollback: patch => route.POST(new Request("http://localhost/api/app", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "rollback-shipped-order", orderId: order.id, ...patch }) })),
    read: () => route.GET(new Request("http://localhost/api/app")),
    file: id => files.GET(new Request(`http://localhost/api/files/${id}`), { params: Promise.resolve({ id }) }),
  };
}

test("shipment rollback is admin-only, including already-settled orders", async () => {
  for (const [actor, expected] of [[null, 401], [buyer, 403]]) {
    const f = fixture({ actor }); assert.equal((await f.rollback()).status, expected); assert.equal(f.operations.length, 0);
  }
});

test("shipment rollback validates order ID and optional reason before writing", async () => {
  for (const patch of [{ orderId: "" }, { orderId: null }, { orderId: 42 }, { reason: null }, { reason: {} }, { reason: "x".repeat(501) }]) {
    const f = fixture(); assert.equal((await f.rollback(patch)).status, 400, JSON.stringify(patch)); assert.equal(f.operations.length, 0);
  }
  const f = fixture(); assert.equal((await f.rollback({ orderId: "missing" })).status, 404); assert.equal(f.operations.length, 0);
});

test("only a nonempty completely shipped order is eligible", async () => {
  for (const status of ["待审核", "在途", "待发货", "已驳回"]) {
    const f = fixture({ status }); assert.equal((await f.rollback()).status, 409); assert.equal(f.operations.length, 0);
  }
  for (const count of [0, 1, 2]) {
    const f = fixture();
    if (!count) f.state.orderItems = []; else for (const item of f.state.orderItems.slice(0, count)) item.shippedAt = null;
    assert.equal((await f.rollback()).status, 409); assert.equal(f.operations.length, 0);
  }
});

test("missing, extra, unshipped or mismatched inventory lots block rollback without mutations", async () => {
  const corruptions = [
    f => { f.state.inventoryLots.shift(); },
    f => { f.state.inventoryLots.push({ ...f.state.inventoryLots[0], itemId: "extra" }); },
    f => { f.state.inventoryLots[0].shippedAt = null; },
    f => { f.state.inventoryLots[0].sku = "wrong"; },
    f => { f.state.inventoryLots[0].size = "L"; },
    f => { f.state.inventoryLots[0].qty = 1; },
    f => { f.state.inventoryLots[0].itemId = f.state.inventoryLots[1].itemId; },
    f => { f.state.inventoryLots[0].qty = f.state.orderItems[0].qty = 0; },
  ];
  for (const corrupt of corruptions) {
    const f = fixture(); corrupt(f); const before = structuredClone(f.state);
    assert.equal((await f.rollback()).status, 409); assert.deepEqual(f.state, before); assert.equal(f.operations.length, 0);
  }
});

test("settled and unsettled full shipments reset lifecycle but preserve purchase data and shared SKU inventory", async () => {
  for (const options of [{ settled: true }, { settled: false }, { status: "已发货" }]) {
    const f = fixture(options), before = structuredClone(f.state);
    const response = await f.rollback({ reason: "  线下已核对  " }); assert.equal(response.status, 200);
    const order = f.state.purchaseOrders[0];
    assert.equal(order.status, "在途"); assert.equal(order.settled, false); assert.equal(order.isReturned, true);
    for (const key of ["receivedAt", "location", "settledAt", "settledBy", "settledAmountCents"]) assert.equal(order[key], null, key);
    for (const key of ["platform", "platformOrderNo", "purchaserId", "auditorId", "courierCompany", "courierNo", "createdAt"]) assert.equal(order[key], before.purchaseOrders[0][key], key);
    for (const [index, item] of f.state.orderItems.entries()) {
      for (const key of ["shippedAt", "outboundCompany", "outboundCourierNo", "resalePlatform", "resaleOrderNo", "salePriceCents"]) assert.equal(item[key], null, key);
      for (const key of ["id", "title", "sku", "size", "qty", "amountCents", "purchaseCourierCompany", "purchaseCourierNo", "createdAt"]) assert.equal(item[key], before.orderItems[index][key], key);
    }
    assert.deepEqual(f.state.inventory, before.inventory);
    assert.deepEqual(f.state.inventoryLots, [before.inventoryLots[2]], "other order's identical SKU lot remains untouched");
    assert.deepEqual(f.state.inventoryMovements.slice(0, 4), before.inventoryMovements);
    assert.deepEqual(f.state.inventoryMovements.slice(4).map(row => [row.changeQty, row.type]), [[2, "adjust"], [-2, "adjust"], [3, "adjust"], [-3, "adjust"]]);
    assert.equal(f.state.inventoryMovements.reduce((sum, row) => sum + row.changeQty, 0), 0);
    assert.deepEqual(f.state.orderImages, before.orderImages.map(image => image.kind === "settlement" ? { ...image, kind: "settlement_archived" } : image));
    assert.equal(f.filesRemoved.length, 0);
    assert.equal(f.operations.some(op => op.table === "inventory"), false);
    assert.deepEqual(f.locks, ["purchaseOrders", "orderItems", "inventoryLots", "orderImages"]);
    const audit = f.state.auditLogs[0], detail = JSON.parse(audit.detailJson);
    assert.equal(audit.action, "rollback_shipped_order"); assert.equal(audit.actorId, admin.id);
    assert.equal(detail.reason, "线下已核对"); assert.equal(detail.inventoryNetChange, 0);
    assert.deepEqual(detail.before.order, before.purchaseOrders[0]); assert.deepEqual(detail.before.items, before.orderItems);
    assert.deepEqual(detail.before.settlementProofs, [before.orderImages[1]]); assert.equal(detail.after.order.status, "在途");
    assert.equal(detail.before.order.isReturned, false); assert.equal(detail.after.order.isReturned, true);
    const data = (await response.json()).data.orders[0]; assert.equal(data.status, "在途"); assert.equal(data.isReturned, true); assert.equal(data.images.length, 1); assert.deepEqual(data.settlementProofs, []);
    assert.equal(detail.reversals.length, 2);
  }
});

test("audit failure atomically rolls back returned flag, fields, compensations, lots and settlement proof archival", async () => {
  const f = fixture({ failAudit: true }), before = structuredClone(f.state);
  assert.equal((await f.rollback()).status, 500); assert.deepEqual(f.state, before); assert.equal(f.filesRemoved.length, 0);
  assert.equal(f.state.purchaseOrders[0].isReturned, false);
});

test("retrying a successful rollback returns conflict without double compensation", async () => {
  const f = fixture(); assert.equal((await f.rollback()).status, 200);
  const state = structuredClone(f.state), operations = f.operations.length;
  assert.equal((await f.rollback()).status, 409); assert.deepEqual(f.state, state); assert.equal(f.operations.length, operations);
});

test("archived proofs remain admin-readable but cannot be fetched by their owning buyer", async () => {
  const f = fixture(); assert.equal((await f.rollback()).status, 200);
  const read = await f.file("image-1"); assert.equal(read.status, 200); assert.equal(read.headers.get("cache-control"), "private, no-store");
  assert.equal(await read.text(), "file"); assert.equal(f.filesRead.length, 1);
  f.login(buyer);
  assert.equal((await f.file("image-1")).status, 403); assert.equal(f.filesRead.length, 1, "denial must precede disk read");
  assert.equal((await f.file("image-0")).status, 200, "ordinary purchase screenshots remain available");
  const data = await (await f.read()).json(); assert.deepEqual(data.orders[0].settlementProofs, []); assert.equal(data.orders[0].status, "在途");
  assert.equal("isReturned" in data.orders[0], false, "returned history must not reveal a prior shipment to buyers");
});

test("shipping edits lock the order before its item and reject stale requests after rollback", async () => {
  const f = fixture(); assert.equal((await f.post({ action: "update-shipping", itemId: "item-0", company: "顺丰", courier: "SF-new", salePrice: "123" })).status, 200);
  assert.deepEqual(f.locks, ["purchaseOrders", "orderItems"]); assert.equal(f.state.orderItems[0].shippedAt, stamp);
  assert.equal((await f.rollback()).status, 200); const before = structuredClone(f.state);
  assert.equal((await f.post({ action: "update-shipping", itemId: "item-0", company: "顺丰", courier: "SF-stale" })).status, 409);
  assert.deepEqual(f.state, before);
});
