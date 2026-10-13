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
const jsonCode = compile(await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"));
const multipartCode = compile(await readFile(new URL("../app/api/settlements/route.ts", import.meta.url), "utf8"));
const admin = { id: "admin", name: "管理员", role: "admin", active: true, approvalStatus: "approved", phone: "", wechatId: "admin" };
const buyer = { ...admin, id: "buyer", name: "采购员", role: "buyer", wechatId: "buyer" };

function order(id = "transit", status = "在途", patch = {}) {
  return {
    id, status, purchaserId: buyer.id, platform: "淘宝", platformOrderNo: `number-${id}`,
    courierCompany: "顺丰", courierNo: "SF123", settled: false, settledAt: null,
    settledBy: null, settledAmountCents: null, receivedAt: status === "已入库" ? "2026-10-10T00:00:00.000Z" : null,
    location: status === "已入库" ? "A1" : null, createdAt: "2026-10-09T00:00:00.000Z", ...patch,
  };
}

// Execute both real handlers against transactional persistence and file I/O doubles.
function fixture({ orders = [order()], actor = admin, failAuditAt = 0 } = {}) {
  const names = ["purchaseOrders", "users", "orderImages", "orderItems", "auditLogs", "inventory", "inventoryLots", "inventoryMovements", "dashboardNotices", "productKnowledge"];
  const tables = Object.fromEntries(names.map(name => [name, new Proxy({ name }, {
    get(target, key) { return key === "name" ? target.name : { table: name, key }; },
  })]));
  let state = Object.fromEntries(names.map(name => [name, []]));
  state.purchaseOrders = structuredClone(orders);
  state.users = [admin, buyer];
  state.orderItems = orders.map(row => ({
    id: `item-${row.id}`, orderId: row.id, title: "测试商品", sku: `SKU-${row.id}`, size: "M", qty: 2,
    amountCents: 10000, purchaseCourierCompany: "顺丰", purchaseCourierNo: "SF123", shippedAt: null,
  }));
  const files = new Set(), operations = [];
  let auditCount = 0;
  const drizzle = {
    eq: (column, value) => row => row[column.key] === value,
    ne: (column, value) => row => row[column.key] !== value,
    and: (...predicates) => row => predicates.every(predicate => predicate(row)),
    or: (...predicates) => row => predicates.some(predicate => predicate(row)),
    inArray: (column, values) => row => values.includes(row[column.key]),
    isNull: column => row => row[column.key] == null,
    gte: (column, value) => row => row[column.key] >= value,
    desc: column => column,
    sql: (parts, ...values) => ({ parts, values }),
  };
  const query = getState => ({
    select: projection => ({ from(table) {
      const predicates = [];
      let count = Infinity;
      const rows = () => getState()[table.name].filter(row => predicates.every(predicate => predicate(row))).slice(0, count).map(row => projection
        ? Object.fromEntries(Object.entries(projection).map(([key, column]) => [key, row[column.key]]))
        : structuredClone(row));
      const builder = {
        where(predicate) { predicates.push(predicate); return builder; },
        orderBy() { return builder; }, for() { return builder; },
        limit(value) { count = value; return builder; },
        then(resolve, reject) { return Promise.resolve(rows()).then(resolve, reject); },
      };
      return builder;
    } }),
    update: table => ({ set: patch => ({ where: predicate => {
      operations.push({ action: "update", table: table.name, values: structuredClone(patch) });
      const changed = getState()[table.name].filter(predicate);
      changed.forEach(row => Object.assign(row, structuredClone(patch)));
      return {
        returning: async projection => changed.map(row => Object.fromEntries(Object.entries(projection).map(([key, column]) => [key, row[column.key]]))),
        then: (resolve, reject) => Promise.resolve().then(resolve, reject),
      };
    } }) }),
    insert: table => ({ values: value => {
      const rows = Array.isArray(value) ? value : [value];
      const insert = () => {
        for (const row of rows) {
          if (table.name === "auditLogs" && ++auditCount === failAuditAt) throw new Error("audit failed");
          operations.push({ action: "insert", table: table.name, values: structuredClone(row) });
          getState()[table.name].push(structuredClone(row));
        }
      };
      return {
        onConflictDoUpdate: async () => {
          assert.equal(table.name, "inventory", "this fixture only upserts stock on receipt");
          for (const row of rows) {
            const existing = getState().inventory.find(saved => saved.sku === row.sku && saved.size === row.size);
            if (existing) { existing.quantity += row.quantity; existing.title = row.title; }
            else getState().inventory.push(structuredClone(row));
            operations.push({ action: "upsert", table: table.name, values: structuredClone(row) });
          }
        },
        then: (resolve, reject) => Promise.resolve().then(insert).then(resolve, reject),
      };
    } }),
  });
  const db = {
    ...query(() => state),
    transaction: async callback => {
      const next = structuredClone(state);
      const result = await callback(query(() => next));
      state = next;
      return result;
    },
  };
  const modules = {
    "@/db": { getDb: () => db }, "@/db/schema": tables, "drizzle-orm": drizzle,
    "@/lib/order-settlement": settlement,
    "@/lib/auth": {
      assertSameOrigin: () => {}, requireAppUser: async () => actor,
      requireAdmin: user => { if (user.role !== "admin") throw Response.json({ error: "权限不足" }, { status: 403 }); },
      routeError: error => error instanceof Response ? error : Response.json({ error: error.message }, { status: 500 }),
    },
    "@/lib/server-time": { serverClock: () => ({ now: "2026-10-13T00:00:00.000Z", timeZone: "Asia/Shanghai" }) },
    "@/lib/time": { dateKey: () => "2026-10-13", timestamp: value => Date.parse(value) },
    "@/lib/file-storage": { imageExtension: type => type === "image/png" ? ".png" : null, uploadPath: key => `/uploads/${key}` },
    "node:fs/promises": {
      mkdir: async () => {}, unlink: async path => { files.delete(path); },
      writeFile: async (path, _data, options) => { assert.equal(options.flag, "wx"); files.add(path); },
    },
  };
  const load = code => {
    const route = {};
    new Function("require", "exports", code)(id => modules[id] ?? require(id), route);
    return route;
  };
  const json = load(jsonCode), multipart = load(multipartCode);
  return {
    get state() { return state; }, files, operations,
    json: body => json.POST(new Request("http://localhost/api/app", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })),
    multipart: ({ orderId = orders[0]?.id, amount, proof = false } = {}) => {
      const form = new FormData();
      form.set("orderId", orderId ?? "missing");
      if (amount !== undefined) form.set("amount", amount);
      if (proof) form.set("proof", new File(["proof"], "settlement.png", { type: "image/png" }));
      return multipart.POST(new Request("http://localhost/api/settlements", { method: "POST", body: form }));
    },
  };
}

const stockWrites = f => f.operations.filter(operation => ["inventory", "inventoryLots", "inventoryMovements", "orderItems"].includes(operation.table));

test("settlement eligibility includes transit and all received display states, but not unapproved or rejected orders", () => {
  for (const status of ["在途", "已入库", "待发货", "已发货"]) {
    assert.equal(settlement.isSettlementStage(status), true, status);
    assert.equal(settlement.canSettleOrder({ status, settled: false }), true, status);
    assert.equal(settlement.canSettleOrder({ status, settled: true }), false, status);
  }
  for (const status of ["待审核", "已驳回", "", "未知状态"]) {
    assert.equal(settlement.isSettlementStage(status), false, status);
    assert.equal(settlement.canSettleOrder({ status, settled: false }), false, status);
  }
});

test("multipart settlement accepts transit orders with optional amount and optional proof without receiving stock", async () => {
  for (const options of [{}, { amount: "258.50" }, { proof: true }, { proof: true, amount: "258.50" }]) {
    const f = fixture();
    const beforeItems = structuredClone(f.state.orderItems);
    const response = await f.multipart(options);
    assert.equal(response.status, 200, JSON.stringify(options));
    const result = await response.json();
    const saved = f.state.purchaseOrders[0];
    assert.equal(saved.settled, true);
    assert.equal(saved.settledAmountCents, options.amount ? 25850 : null);
    assert.equal(saved.settledBy, admin.id);
    assert.ok(saved.settledAt);
    assert.equal(saved.status, "在途");
    assert.equal(saved.receivedAt, null);
    assert.equal(saved.location, null);
    assert.deepEqual(f.state.orderItems, beforeItems);
    assert.equal(stockWrites(f).length, 0);
    assert.equal(f.files.size, options.proof ? 1 : 0);
    assert.equal(f.state.orderImages.length, options.proof ? 1 : 0);
    if (options.proof) assert.equal(f.state.orderImages[0].kind, "settlement");
    assert.equal(result.proofUploaded, Boolean(options.proof));
    assert.equal(f.state.auditLogs[0].action, "settle");
    assert.equal(JSON.parse(f.state.auditLogs[0].detailJson).shippingIndependent, true);
  }
});

test("JSON settlement accepts transit and received orders, preserving stock and shipment information", async () => {
  for (const status of ["在途", "已入库"]) {
    for (const amount of [undefined, 258.5]) {
      const original = order("single", status), f = fixture({ orders: [original] });
      const response = await f.json({ action: "settle-order", orderId: original.id, amount });
      assert.equal(response.status, 200, `${status}/${amount}`);
      assert.equal(f.state.purchaseOrders[0].settledAmountCents, amount === undefined ? null : 25850);
      assert.equal(f.state.purchaseOrders[0].status, status);
      assert.equal(f.state.purchaseOrders[0].receivedAt, original.receivedAt);
      assert.equal(f.state.purchaseOrders[0].location, original.location);
      assert.equal(f.state.orderItems[0].shippedAt, null);
      assert.equal(stockWrites(f).length, 0);
      assert.equal((await response.json()).data.orders[0].settled, true);
    }
  }
});

test("batch settlement atomically accepts a mixed transit and received batch without recording amounts or changing flow", async () => {
  const originals = [order("transit"), order("received", "已入库")], f = fixture({ orders: originals });
  const response = await f.json({ action: "batch-settle", orderIds: ["transit", "received", "transit"] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).settledCount, 2);
  for (let index = 0; index < originals.length; index++) {
    const saved = f.state.purchaseOrders[index], original = originals[index];
    assert.equal(saved.settled, true);
    assert.equal(saved.settledAmountCents, null);
    assert.equal(saved.status, original.status);
    assert.equal(saved.receivedAt, original.receivedAt);
    assert.equal(saved.location, original.location);
  }
  assert.equal(f.state.purchaseOrders[0].settledAt, f.state.purchaseOrders[1].settledAt);
  assert.deepEqual(f.state.auditLogs.map(row => row.action), ["batch_settle", "batch_settle"]);
  assert.equal(stockWrites(f).length, 0);
});

test("both single settlement endpoints reject pending, rejected, and already settled orders with no persistence", async () => {
  for (const original of [order("pending", "待审核"), order("rejected", "已驳回"), order("paid", "在途", { settled: true })]) {
    for (const transport of ["json", "multipart"]) {
      const f = fixture({ orders: [original] }), before = structuredClone(f.state);
      const response = transport === "json"
        ? await f.json({ action: "settle-order", orderId: original.id })
        : await f.multipart({ proof: true });
      assert.equal(response.status, 409, `${original.status}/${original.settled}/${transport}`);
      assert.deepEqual(f.state, before);
      assert.equal(f.files.size, 0, "rejected multipart submission cleans up its uploaded proof");
    }
  }
});

test("eligibility is based on audited status, not a stale received timestamp", async () => {
  for (const status of ["待审核", "已驳回"]) {
    const f = fixture({ orders: [order("stale", status, { receivedAt: "2026-10-10T00:00:00.000Z" })] });
    assert.equal((await f.json({ action: "settle-order", orderId: "stale" })).status, 409);
    assert.equal((await f.multipart()).status, 409);
    assert.equal(f.state.purchaseOrders[0].settled, false);
  }
});

test("buyers cannot settle their own transit orders through any endpoint", async () => {
  const f = fixture({ actor: buyer }), before = structuredClone(f.state);
  assert.equal((await f.json({ action: "settle-order", orderId: "transit" })).status, 403);
  assert.equal((await f.json({ action: "batch-settle", orderIds: ["transit"] })).status, 403);
  assert.equal((await f.multipart({ proof: true })).status, 403);
  assert.deepEqual(f.state, before);
  assert.equal(f.files.size, 0);
  assert.equal(f.operations.length, 0);
});

test("invalid, missing, or duplicate-settled members reject an entire mixed batch", async () => {
  for (const invalid of [order("invalid", "待审核"), order("invalid", "已驳回"), order("invalid", "在途", { settled: true }), null]) {
    const f = fixture({ orders: [order(), ...(invalid ? [invalid] : [])] }), before = structuredClone(f.state);
    const response = await f.json({ action: "batch-settle", orderIds: ["transit", "invalid"] });
    assert.equal(response.status, invalid ? 409 : 404);
    assert.deepEqual(f.state, before, "valid transit members must not be partially settled");
  }
});

test("audit failure rolls back single and batch settlement and removes the newly uploaded proof", async () => {
  for (const transport of ["json", "multipart", "batch"]) {
    const originals = [order(), order("received", "已入库")];
    const f = fixture({ orders: originals, failAuditAt: transport === "batch" ? 2 : 1 }), before = structuredClone(f.state);
    const response = transport === "multipart"
      ? await f.multipart({ amount: "258.50", proof: true })
      : await f.json(transport === "json" ? { action: "settle-order", orderId: "transit", amount: 258.5 } : { action: "batch-settle", orderIds: originals.map(row => row.id) });
    assert.equal(response.status, 500, transport);
    assert.deepEqual(f.state, before, "all updates and proof references must roll back with the audit");
    assert.equal(f.files.size, 0);
  }
});

test("a settled transit order can still be received; settlement is retained and inventory changes only on receipt", async () => {
  const f = fixture();
  assert.equal((await f.multipart({ amount: "258.50", proof: true })).status, 200);
  const paid = structuredClone(f.state.purchaseOrders[0]), proof = structuredClone(f.state.orderImages);
  assert.equal(stockWrites(f).length, 0);
  const response = await f.json({ action: "receive", orderId: "transit", location: "B2" });
  assert.equal(response.status, 200);
  const received = f.state.purchaseOrders[0];
  for (const field of ["settled", "settledAt", "settledBy", "settledAmountCents"]) assert.equal(received[field], paid[field], field);
  assert.equal(received.status, "已入库");
  assert.ok(received.receivedAt);
  assert.equal(received.location, "B2");
  assert.equal(f.state.inventory[0].quantity, 2);
  assert.equal(f.state.inventoryLots[0].qty, 2);
  assert.equal(f.state.inventoryMovements[0].changeQty, 2);
  assert.equal(f.state.inventoryMovements[0].type, "receive");
  assert.deepEqual(f.state.orderImages, proof);
  assert.deepEqual(f.state.auditLogs.map(row => row.action), ["settle", "receive"]);
  const snapshot = (await response.json()).data.orders[0];
  assert.equal(snapshot.settled, true);
  assert.equal(snapshot.status, "待发货");
  assert.equal(snapshot.settlementProofs.length, 1);
  const before = structuredClone(f.state);
  assert.equal((await f.json({ action: "receive", orderId: "transit", location: "B2" })).status, 409);
  assert.deepEqual(f.state, before, "duplicate receipt must not increment stock twice");
});

test("already settled transit orders remain protected from rejection and duplicate settlement", async () => {
  const f = fixture();
  assert.equal((await f.json({ action: "settle-order", orderId: "transit" })).status, 200);
  const before = structuredClone(f.state);
  const reject = await f.json({ action: "reject", orderId: "transit", reason: "测试驳回" });
  assert.equal(reject.status, 409);
  assert.match((await reject.json()).error, /已结款/);
  assert.equal((await f.json({ action: "settle-order", orderId: "transit" })).status, 409);
  assert.deepEqual(f.state, before);
});
