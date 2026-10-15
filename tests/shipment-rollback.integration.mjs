import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import ts from "typescript";
import * as settlement from "../lib/order-settlement.ts";
import * as time from "../lib/time.ts";

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const schema = {};
new Function("require", "exports", compile(await readFile(new URL("../db/schema.ts", import.meta.url), "utf8")))(require, schema);
const code = compile(await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"));
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const url = new URL(process.env.DATABASE_URL);
if (!/test|ci/i.test(url.pathname)) throw new Error("Shipment rollback integration requires a dedicated test/CI database");
const marker = `shipment_test_${randomUUID().replaceAll("-", "")}`;
const client = postgres(process.env.DATABASE_URL, { max: 5, connection: { application_name: marker, statement_timeout: 10000 } });
const stamp = "2026-10-01T08:00:00.000Z";
const bound = sql => drizzle(Object.assign(sql, { options: client.options }), { schema });
const request = body => new Request("http://localhost/api/app", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
function loadRoute(db, userId) {
  const modules = {
    "@/db": { getDb: () => db }, "@/db/schema": schema,
    "@/lib/auth": {
      assertSameOrigin() {}, requireAppUser: async () => ({ id: userId, role: "admin", name: "回滚集成测试" }), requireAdmin() {},
      routeError: error => error instanceof Response ? error : Response.json({ error: error.message }, { status: 500 }),
    },
    "@/lib/server-time": { serverClock: () => ({ now: stamp, timeZone: "Asia/Shanghai" }) },
    "@/lib/time": time, "@/lib/order-settlement": settlement, "@/lib/file-storage": { uploadPath: key => key },
  };
  const route = {};
  new Function("require", "exports", code)(id => modules[id] ?? require(id), route);
  return body => route.POST(request(body));
}
async function seed(tx, suffix) {
  const id = `${marker}_${suffix}`, other = `${id}_other`, actor = `${id}_admin`, sku = `${id}_sku`;
  await tx`INSERT INTO users (id,wechat_id,name,password_hash,role) VALUES (${actor},${actor},'回滚集成测试','not-a-login-hash','admin')`;
  await tx`INSERT INTO purchase_orders (id,platform,platform_order_no,purchaser_id,auditor_id,status,received_at,location,settled,settled_at,settled_by,settled_amount_cents,courier_company,courier_no)
    VALUES (${id},'淘宝',${id},${actor},${actor},'已入库',${stamp},'A1',true,${stamp},${actor},73400,'京东','JD-purchase'),
      (${other},'淘宝',${other},${actor},${actor},'已入库',${stamp},'B2',false,null,null,null,'京东','JD-other')`;
  const ids = [`${id}_a`, `${id}_b`, `${other}_a`];
  for (const [index, qty] of [2, 3, 7].entries()) {
    const orderId = index < 2 ? id : other, shippedAt = index < 2 ? stamp : null;
    await tx`INSERT INTO order_items (id,order_id,title,sku,size,qty,amount_cents,purchase_courier_company,purchase_courier_no,resale_platform,resale_order_no,sale_price_cents,outbound_company,outbound_courier_no,shipped_at)
      VALUES (${ids[index]},${orderId},${`同款${index}`},${sku},'M',${qty},${qty * 100},'京东',${`JD-${index}`},'得物',${`DW-${index}`},10000,'申通','STO-original',${shippedAt})`;
    await tx`INSERT INTO inventory_lots (item_id,order_id,sku,size,qty,location,received_at,shipped_at)
      VALUES (${ids[index]},${orderId},${sku},'M',${qty},${index < 2 ? "A1" : "B2"},${stamp},${shippedAt})`;
    await tx`INSERT INTO inventory_movements (id,order_id,sku,size,change_qty,type,location,actor_id)
      VALUES (${`${ids[index]}_receive`},${orderId},${sku},'M',${qty},'receive','A1',${actor})`;
    if (shippedAt) await tx`INSERT INTO inventory_movements (id,order_id,sku,size,change_qty,type,location,actor_id)
      VALUES (${`${ids[index]}_ship`},${orderId},${sku},'M',${-qty},'ship','A1',${actor})`;
  }
  await tx`INSERT INTO inventory (sku,size,title,quantity) VALUES (${sku},'M','测试同款',7)`;
  for (const kind of ["order", "settlement", "settlement_archived"]) {
    await tx`INSERT INTO order_images (id,order_id,kind,object_key,file_name,content_type,size_bytes,uploaded_by)
      VALUES (${`${id}_${kind}`},${id},${kind},${`orders/${id}-${kind}.png`},${`${kind}.png`},'image/png',10,${actor})`;
  }
  return { id, other, actor, sku, ids };
}
async function cleanup(f) {
  await client.begin(async tx => {
    await tx`DELETE FROM audit_logs WHERE actor_id=${f.actor}`;
    await tx`DELETE FROM order_images WHERE order_id IN (${f.id},${f.other})`;
    await tx`DELETE FROM inventory_movements WHERE order_id IN (${f.id},${f.other})`;
    await tx`DELETE FROM inventory_lots WHERE order_id IN (${f.id},${f.other})`;
    await tx`DELETE FROM order_items WHERE order_id IN (${f.id},${f.other})`;
    await tx`DELETE FROM purchase_orders WHERE id IN (${f.id},${f.other})`;
    await tx`DELETE FROM inventory WHERE sku=${f.sku}`;
    await tx`DELETE FROM users WHERE id=${f.actor}`;
  });
}
async function verifyReset(sql, f) {
  const [order] = await sql`SELECT * FROM purchase_orders WHERE id=${f.id}`;
  assert.equal(order.status, "在途"); assert.equal(order.settled, false);
  for (const key of ["received_at", "location", "settled_at", "settled_by", "settled_amount_cents"]) assert.equal(order[key], null, key);
  assert.equal(order.purchaser_id, f.actor); assert.equal(order.courier_no, "JD-purchase"); assert.equal(order.auditor_id, f.actor);
  const items = await sql`SELECT * FROM order_items WHERE order_id=${f.id} ORDER BY id`;
  assert.deepEqual(items.map(item => item.qty), [2, 3]); assert.deepEqual(items.map(item => item.amount_cents), [200, 300]);
  for (const item of items) for (const key of ["shipped_at", "outbound_company", "outbound_courier_no", "resale_platform", "resale_order_no", "sale_price_cents"]) assert.equal(item[key], null, key);
  assert.equal((await sql`SELECT * FROM inventory_lots WHERE order_id=${f.id}`).length, 0);
  const [stock] = await sql`SELECT quantity FROM inventory WHERE sku=${f.sku}`; assert.equal(stock.quantity, 7);
  const [other] = await sql`SELECT qty,shipped_at,location FROM inventory_lots WHERE order_id=${f.other}`;
  assert.equal(other.qty, 7); assert.equal(other.shipped_at, null); assert.equal(other.location, "B2");
  const movements = await sql`SELECT change_qty,type FROM inventory_movements WHERE order_id=${f.id}`;
  assert.equal(movements.reduce((sum, row) => sum + row.change_qty, 0), 0);
  assert.equal(movements.filter(row => row.type === "adjust").length, 4);
  const images = await sql`SELECT * FROM order_images WHERE order_id=${f.id} ORDER BY id`;
  assert.equal(images.length, 3); assert.equal(images.filter(image => image.kind === "settlement_archived").length, 2);
  assert.equal(images.find(image => image.id === `${f.id}_settlement`).object_key, `orders/${f.id}-settlement.png`);
  const audits = await sql`SELECT detail_json FROM audit_logs WHERE entity_id=${f.id} AND action='rollback_shipped_order'`;
  assert.equal(audits.length, 1); const detail = JSON.parse(audits[0].detail_json);
  assert.equal(detail.before.order.settledAmountCents, 73400); assert.equal(detail.before.items.length, 2);
  assert.equal(detail.after.order.status, "在途"); assert.equal(detail.inventoryNetChange, 0);
  assert.equal(detail.before.settlementProofs[0].kind, "settlement");
  return detail;
}

try {
  const rollback = new Error("ROLLBACK_SHIPMENT_TEST_FIXTURES");
  try {
    await client.begin(async tx => {
      const f = await seed(tx, "serial"); const database = bound(tx); let failAudit = false;
      const db = { select: database.select.bind(database), transaction: callback => tx.savepoint(async scoped => {
        const next = bound(scoped);
        return callback(new Proxy(next, { get(target, key) {
          if (key === "insert" && failAudit) return table => table === schema.auditLogs
            ? { values: async () => { throw new Error("deliberate audit failure"); } } : target.insert(table);
          const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
        } }));
      }) };
      const post = loadRoute(db, f.actor), payload = { action: "rollback-shipped-order", orderId: f.id, reason: "已线下核对" };
      const before = await tx`SELECT row_to_json(p) AS row FROM purchase_orders p WHERE id=${f.id}`;
      failAudit = true; assert.equal((await post(payload)).status, 500);
      assert.deepEqual(await tx`SELECT row_to_json(p) AS row FROM purchase_orders p WHERE id=${f.id}`, before);
      assert.equal((await tx`SELECT * FROM inventory_lots WHERE order_id=${f.id}`).length, 2);
      assert.equal((await tx`SELECT * FROM inventory_movements WHERE order_id=${f.id} AND type='adjust'`).length, 0);
      assert.equal((await tx`SELECT kind FROM order_images WHERE id=${`${f.id}_settlement`}`)[0].kind, "settlement");
      failAudit = false;
      await tx`DELETE FROM inventory_lots WHERE item_id=${f.ids[0]}`;
      assert.equal((await post(payload)).status, 409);
      await tx`INSERT INTO inventory_lots (item_id,order_id,sku,size,qty,location,received_at,shipped_at)
        VALUES (${f.ids[0]},${f.id},${f.sku},'M',2,'A1',${stamp},${stamp})`;
      const response = await post(payload); assert.equal(response.status, 200);
      const visible = (await response.json()).data.orders.find(row => row.id === f.id);
      assert.equal(visible.images.length, 1); assert.deepEqual(visible.settlementProofs, []);
      await verifyReset(tx, f);
      assert.equal((await post(payload)).status, 409);
      assert.equal((await post({ action: "update-shipping", itemId: f.ids[0], company: "顺丰", courier: "SF-stale" })).status, 409);
      // Re-enter every normal lifecycle path against real constraints and aggregate stock.
      assert.equal((await post({ action: "settle-order", orderId: f.id, amount: "500" })).status, 200);
      assert.equal((await post({ action: "receive", orderId: f.id, location: "C3" })).status, 200);
      assert.equal((await tx`SELECT quantity FROM inventory WHERE sku=${f.sku}`)[0].quantity, 12);
      assert.equal((await tx`SELECT * FROM inventory_lots WHERE order_id=${f.id}`).length, 2);
      for (const itemId of f.ids.slice(0, 2)) assert.equal((await post({ action: "ship", itemId, company: "顺丰", courier: "SF-new", salePrice: "20" })).status, 200);
      assert.equal((await tx`SELECT quantity FROM inventory WHERE sku=${f.sku}`)[0].quantity, 7);
      const [net] = await tx`SELECT sum(change_qty)::int AS n FROM inventory_movements WHERE order_id=${f.id}`; assert.equal(net.n, 0);
      const [settledOrder] = await tx`SELECT settled,settled_amount_cents FROM purchase_orders WHERE id=${f.id}`;
      assert.equal(settledOrder.settled, true); assert.equal(settledOrder.settled_amount_cents, 50000);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }

  // These fixtures must be committed to be visible on distinct connections. All are
  // namespaced by UUID, restricted to a test DB, and removed in finally below.
  for (const concurrentAction of ["rollback-shipped-order", "update-shipping", "ship-then-rollback"]) {
    const f = await client.begin(tx => seed(tx, concurrentAction));
    let release; const held = new Promise(resolve => { release = resolve; });
    let entered; const paused = new Promise(resolve => { entered = resolve; });
    let pauseOnce = true; const database = bound(client);
    const db = { select: database.select.bind(database), transaction: callback => client.begin(async scoped => {
      const result = await callback(bound(scoped));
      if (pauseOnce) { pauseOnce = false; entered(); await held; }
      return result;
    }) };
    const post = loadRoute(db, f.actor); const pending = [];
    try {
      if (concurrentAction === "ship-then-rollback") {
        await client.begin(async tx => {
          await tx`UPDATE order_items SET shipped_at=null WHERE id=${f.ids[1]}`;
          await tx`UPDATE inventory_lots SET shipped_at=null WHERE item_id=${f.ids[1]}`;
          await tx`DELETE FROM inventory_movements WHERE id=${`${f.ids[1]}_ship`}`;
          await tx`UPDATE inventory SET quantity=10 WHERE sku=${f.sku}`;
        });
      }
      const first = post(concurrentAction === "ship-then-rollback"
        ? { action: "ship", itemId: f.ids[1], company: "顺丰", courier: "SF-concurrent" }
        : { action: "rollback-shipped-order", orderId: f.id }); pending.push(first);
      let pauseTimer;
      try {
        await Promise.race([paused, first.then(async response => { throw new Error(`First transaction exited before lock barrier: ${response.status} ${await response.text()}`); }),
          new Promise((_, reject) => { pauseTimer = setTimeout(() => reject(new Error("First transaction did not reach the lock barrier within 10 seconds")), 10000); })]);
      } finally { clearTimeout(pauseTimer); }
      const second = post(concurrentAction !== "update-shipping"
        ? { action: "rollback-shipped-order", orderId: f.id }
        : { action: concurrentAction, itemId: f.ids[0], courier: "STALE-SHOULD-NOT-WRITE", company: "顺丰", salePrice: "1" });
      pending.push(second);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await client`SELECT pid FROM pg_stat_activity WHERE application_name=${marker} AND wait_event_type='Lock'`;
        if (rows.length) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, "second real PG transaction must wait behind the rollback's parent-order lock");
      release();
      assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [200, concurrentAction === "ship-then-rollback" ? 200 : 409]);
      const detail = await verifyReset(client, f);
      if (concurrentAction === "ship-then-rollback") assert.equal(detail.before.items.find(item => item.id === f.ids[1]).outboundCourierNo, "SF-concurrent", "rollback waits for the final shipment and audits its committed state");
    } finally {
      release(); await Promise.allSettled(pending); await cleanup(f);
    }
  }
  console.log("Shipment rollback real PG migration, audit rollback, same-SKU isolation, proof archival, lifecycle re-entry, simultaneous rollback and stale-shipping lock behavior verified; fixtures removed.");
} finally { await client.end(); }
