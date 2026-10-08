import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const orderCode = compile(await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"));
const imageCode = compile(await readFile(new URL("../app/api/order-images/route.ts", import.meta.url), "utf8"));
const admin = { id: "admin", name: "管理员", role: "admin", active: true, approvalStatus: "approved", phone: "", wechatId: "admin", createdAt: "2026-10-08T00:00:00.000Z" };
const buyer = { ...admin, id: "buyer", name: "采购员", role: "buyer", wechatId: "buyer" };
const otherAdmin = { ...admin, id: "other-admin", name: "另一管理员", wechatId: "other-admin" };
const validItem = { title: "测试商品", sku: "SKU-1", size: "M", qty: 2, amount: 100, purchaseCourierCompany: "顺丰", purchaseCourierNo: "SF123" };

// Execute the real handlers with query predicates and transactional persistence.
function fixture({ actor = admin, people = [admin, buyer, otherAdmin] } = {}) {
  const names = ["purchaseOrders", "users", "orderImages", "orderItems", "auditLogs", "inventory", "inventoryLots", "inventoryMovements", "dashboardNotices", "productKnowledge"];
  const tables = Object.fromEntries(names.map(name => [name, new Proxy({ name }, {
    get(target, key) { return key === "name" ? target.name : { table: name, key }; },
  })]));
  let state = Object.fromEntries(names.map(name => [name, name === "users" ? structuredClone(people) : []]));
  const operations = [], files = new Set();
  const drizzle = {
    eq: (column, value) => row => row[column.key] === value,
    ne: (column, value) => row => row[column.key] !== value,
    and: (...predicates) => row => predicates.every(predicate => predicate(row)),
    or: (...predicates) => row => predicates.some(predicate => predicate(row)),
    inArray: (column, values) => row => values.includes(row[column.key]),
    isNull: column => row => row[column.key] == null,
    gte: (column, value) => row => row[column.key] >= value,
    desc: column => column,
    sql: () => null,
  };
  const query = getState => ({
    select: projection => ({ from(table) {
      let predicates = [], count = Infinity;
      const values = () => getState()[table.name].filter(row => predicates.every(predicate => predicate(row))).slice(0, count).map(row => projection
        ? Object.fromEntries(Object.entries(projection).map(([key, column]) => [key, row[column.key]]))
        : structuredClone(row));
      const builder = {
        where(predicate) { predicates.push(predicate); return builder; },
        orderBy() { return builder; },
        for() { return builder; },
        limit(value) { count = value; return builder; },
        then(resolve, reject) { return Promise.resolve(values()).then(resolve, reject); },
      };
      return builder;
    } }),
    insert: table => ({ values: value => {
      const rows = Array.isArray(value) ? value : [value];
      for (const row of rows) {
        operations.push({ action: "insert", table: table.name, values: structuredClone(row) });
        getState()[table.name].push({ ...(table === tables.purchaseOrders ? { status: "待审核", settled: false } : {}), ...structuredClone(row) });
      }
      return Promise.resolve();
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
    "@/lib/auth": {
      assertSameOrigin: () => {}, requireAppUser: async () => actor,
      requireAdmin: user => { if (user.role !== "admin") throw new Response(null, { status: 403 }); },
      routeError: error => error instanceof Response ? error : Response.json({ error: error.message }, { status: 500 }),
    },
    "@/lib/server-time": { serverClock: () => ({ now: "2026-10-08T00:00:00.000Z", timeZone: "Asia/Shanghai" }) },
    "@/lib/time": { dateKey: () => "2026-10-08", timestamp: value => Date.parse(value) },
    "@/lib/file-storage": { imageExtension: type => type === "image/png" ? ".png" : null, uploadPath: key => `/uploads/${key}` },
    "node:fs/promises": { mkdir: async () => {}, writeFile: async path => { files.add(path); }, unlink: async path => { files.delete(path); } },
  };
  const load = code => {
    const route = {};
    new Function("require", "exports", code)(id => modules[id] ?? require(id), route);
    return route;
  };
  const orderRoute = load(orderCode), imageRoute = load(imageCode);
  return {
    operations, files, get state() { return state; },
    login: user => { actor = user; },
    read: async () => orderRoute.GET(new Request("http://localhost/api/app")),
    create: async patch => orderRoute.POST(new Request("http://localhost/api/app", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create-order", platform: "淘宝", platformNo: "T1", items: [validItem], ...patch }),
    })),
    upload: async orderId => {
      const form = new FormData();
      form.set("orderId", orderId);
      form.set("files", new File(["test-image"], "order.png", { type: "image/png" }));
      return imageRoute.POST(new Request("http://localhost/api/order-images", { method: "POST", body: form }));
    },
  };
}

test("creating an order without purchaserId defaults to the signed-in user", async () => {
  for (const actor of [admin, buyer]) {
    const f = fixture({ actor });
    assert.equal((await f.create()).status, 201);
    assert.equal(f.state.purchaseOrders[0].purchaserId, actor.id);
    assert.equal(f.state.auditLogs[0].actorId, actor.id);
  }
});

test("administrators can create orders for active approved buyers and administrators", async () => {
  for (const purchaser of [buyer, otherAdmin, admin]) {
    const f = fixture();
    const response = await f.create({ purchaserId: purchaser.id });
    assert.equal(response.status, 201, purchaser.id);
    const result = await response.json();
    assert.equal(f.state.purchaseOrders[0].purchaserId, purchaser.id);
    assert.equal(result.data.orders[0].purchaser, purchaser.name);
    assert.equal(result.data.orders[0].purchaserId, purchaser.id);
    assert.equal(f.state.auditLogs[0].actorId, admin.id, "creation records the real signed-in actor");
    assert.equal(JSON.parse(f.state.auditLogs[0].detailJson).purchaserId, purchaser.id, "creation audit retains the chosen purchaser");
  }
});

test("unknown, inactive, pending, and rejected purchasers are rejected before inserts", async () => {
  for (const target of [
    null,
    { ...buyer, active: false },
    { ...buyer, approvalStatus: "pending" },
    { ...buyer, approvalStatus: "rejected" },
  ]) {
    const f = fixture({ people: [admin, ...(target ? [target] : [])] });
    const response = await f.create({ purchaserId: buyer.id });
    assert.equal(response.status, 409, JSON.stringify(target));
    assert.match((await response.json()).error, /已审批通过.*启用/);
    assert.equal(f.operations.length, 0, "invalid assignment must not write order, items, or audit rows");
    assert.equal(f.state.purchaseOrders.length, 0);
  }
  for (const purchaserId of ["", "   ", null, 123, {}]) {
    const f = fixture();
    assert.equal((await f.create({ purchaserId })).status, 409, JSON.stringify(purchaserId));
    assert.equal(f.operations.length, 0);
  }
});

test("buyers cannot create an order on behalf of another purchaser", async () => {
  for (const purchaserId of [admin.id, otherAdmin.id, "unknown"]) {
    const f = fixture({ actor: buyer });
    assert.equal((await f.create({ purchaserId })).status, 403, purchaserId);
    assert.equal(f.operations.length, 0);
  }
  const own = fixture({ actor: buyer });
  assert.equal((await own.create({ purchaserId: buyer.id })).status, 201);
  assert.equal(own.state.purchaseOrders[0].purchaserId, buyer.id);
});

test("administrators can attach order screenshots to buyer-owned orders they create", async () => {
  const f = fixture();
  const response = await f.create({ purchaserId: buyer.id });
  assert.equal(response.status, 201);
  const { createdOrderId } = await response.json();
  assert.equal((await f.upload(createdOrderId)).status, 201);
  assert.equal(f.files.size, 1);
  assert.equal(f.state.orderImages[0].orderId, createdOrderId);
  assert.equal(f.state.orderImages[0].uploadedBy, admin.id);
  assert.equal(f.state.purchaseOrders[0].purchaserId, buyer.id);
});

test("assigned orders appear only in the chosen buyer's snapshot and allow that buyer's attachments", async () => {
  const unrelatedBuyer = { ...buyer, id: "unrelated-buyer", name: "其他采购员", wechatId: "unrelated" };
  const f = fixture({ people: [admin, buyer, unrelatedBuyer] });
  const response = await f.create({ purchaserId: buyer.id });
  assert.equal(response.status, 201);
  const { createdOrderId } = await response.json();
  f.login(unrelatedBuyer);
  assert.equal((await (await f.read()).json()).orders.length, 0);
  assert.equal((await f.upload(createdOrderId)).status, 403);
  assert.equal(f.files.size, 0);
  f.login(buyer);
  const snapshot = await (await f.read()).json();
  assert.equal(snapshot.orders.length, 1);
  assert.equal(snapshot.orders[0].id, createdOrderId);
  assert.equal(snapshot.orders[0].purchaserId, buyer.id);
  assert.equal((await f.upload(createdOrderId)).status, 201);
  assert.equal(f.state.orderImages[0].uploadedBy, buyer.id);
});
