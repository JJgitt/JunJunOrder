import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import postgres from "postgres";
import {drizzle} from "drizzle-orm/postgres-js";
import ts from "typescript";
import * as settlement from "../lib/order-settlement.ts";
import * as time from "../lib/time.ts";

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText;
const schema = {};
new Function("require", "exports", compile(await readFile(new URL("../db/schema.ts", import.meta.url), "utf8")))(require, schema);
const code = compile(await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"));
if (!process.env.DATABASE_URL || !/test|ci/i.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error("Use a dedicated test/CI database");
const marker = `item_return_${randomUUID().replaceAll("-", "")}`;
const client = postgres(process.env.DATABASE_URL, {max: 4, connection: {statement_timeout: 10000}});
const stamp = "2026-10-18T04:00:00.000Z";
const bound = sql => drizzle(Object.assign(sql, {options: client.options}), {schema});
function route(db, id, role = "admin") {
    const modules = {
        "@/db": {getDb: () => db}, "@/db/schema": schema,
        "@/lib/auth": {
            assertSameOrigin() {}, requireAppUser: async () => ({id, role, name: "测试采购人"}),
            requireAdmin: user => {if (user.role !== "admin") throw new Response(null, {status: 403});},
            routeError: error => error instanceof Response ? error : Response.json({error: error.message}, {status: (error.code ?? error.cause?.code) === "23505" ? 409 : 500}),
        },
        "@/lib/server-time": {serverClock: () => ({now: stamp, timeZone: "Asia/Shanghai"})},
        "@/lib/time": time, "@/lib/order-settlement": settlement, "@/lib/file-storage": {uploadPath: key => key},
    };
    const result = {};
    new Function("require", "exports", code)(name => modules[name] ?? require(name), result);
    return {
        post: body => result.POST(new Request("http://localhost/api/app", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)})),
        get: () => result.GET(new Request("http://localhost/api/app")),
    };
}
async function seed(tx, suffix) {
    const id = `${marker}_${suffix}`, actor = `${id}_user`, sku = `${id}_sku`, a = `${id}_a`, b = `${id}_b`;
    await tx`INSERT INTO users (id,wechat_id,name,password_hash,role) VALUES (${actor},${actor},'测试采购人','not-a-login-hash','admin')`;
    await tx`INSERT INTO purchase_orders (id,platform,platform_order_no,purchaser_id,status,received_at,location,settled,settled_at,settled_by,settled_amount_cents)
        VALUES (${id},'淘宝',${id},${actor},'已入库',${stamp},'A1',true,${stamp},${actor},1400)`;
    for (const [itemId, qty, amount] of [[a, 3, 1000], [b, 2, 400]]) {
        await tx`INSERT INTO order_items (id,order_id,title,sku,size,qty,amount_cents,purchase_courier_company,purchase_courier_no,outbound_company,outbound_courier_no,shipped_at,sale_price_cents)
            VALUES (${itemId},${id},'同款测试',${sku},'M',${qty},${amount},'顺丰','SF-old','京东','JD-shipped',${stamp},2000)`;
        await tx`INSERT INTO inventory_lots (item_id,order_id,sku,size,qty,location,received_at,shipped_at)
            VALUES (${itemId},${id},${sku},'M',${qty},'A1',${stamp},${stamp})`;
        for (const change of [qty, -qty]) await tx`INSERT INTO inventory_movements (id,order_id,sku,size,change_qty,type,actor_id)
            VALUES (${`${itemId}_${change}`},${id},${sku},'M',${change},${change > 0 ? "receive" : "ship"},${actor})`;
    }
    await tx`INSERT INTO inventory (sku,size,title,quantity) VALUES (${sku},'M','其他订单在库',7)`;
    await tx`INSERT INTO order_images (id,order_id,kind,object_key,file_name,content_type,size_bytes,uploaded_by)
        VALUES (${`${id}_proof`},${id},'settlement',${`orders/${id}.png`},'proof.png','image/png',10,${actor})`;
    return {id, actor, sku, a, b};
}
const payload = (f, changes = {}) => ({action: "return-order-item", orderId: f.id, itemId: f.a, qty: 1, platformNo: `${f.id}_new`, company: "其他物流", courier: "RETURN-001", ...changes});
async function expectStatus(promise, status) {
    const response = await promise, json = await response.json().catch(() => ({}));
    assert.equal(response.status, status, JSON.stringify(json.error));
    return json;
}
try {
    const rollback = new Error("ROLLBACK_TEST_DATA");
    try {
        await client.begin(async tx => {
            const f = await seed(tx, "serial"), db = bound(tx);
            let failAudit = false;
            const wrapped = {select: db.select.bind(db), transaction: callback => tx.savepoint(scoped => {
                const database = bound(scoped);
                return callback(new Proxy(database, {get(target, key) {
                    if (key === "insert" && failAudit) return table => table === schema.auditLogs
                        ? {values: async () => {throw new Error("deliberate audit failure");}} : target.insert(table);
                    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
                }}));
            })};
            const admin = route(wrapped, f.actor), buyer = route(wrapped, f.actor, "buyer");
            await expectStatus(buyer.post(payload(f)), 403);
            for (const changes of [{qty: 0}, {qty: -1}, {qty: 1.5}, {qty: "1"}, {qty: 2147483648}, {platformNo: " "}, {company: ""}, {courier: ""}, {courier: "x".repeat(101)}]) await expectStatus(admin.post(payload(f, changes)), 400);
            await expectStatus(admin.post(payload(f, {itemId: "not-owned"})), 404);
            await expectStatus(admin.post(payload(f, {qty: 4})), 409);
            await tx`UPDATE order_items SET shipped_at=null WHERE id=${f.b}`;
            await expectStatus(admin.post(payload(f)), 409);
            await tx`UPDATE order_items SET shipped_at=${stamp} WHERE id=${f.b}`;
            await tx`UPDATE inventory_lots SET qty=2 WHERE item_id=${f.a}`;
            await expectStatus(admin.post(payload(f)), 409);
            await tx`UPDATE inventory_lots SET qty=3 WHERE item_id=${f.a}`;
            const before = (await tx`SELECT row_to_json(p) AS row FROM purchase_orders p WHERE id=${f.id}`)[0].row;
            const beforeItems = await tx`SELECT row_to_json(i) AS row FROM order_items i WHERE order_id=${f.id} ORDER BY id`;
            failAudit = true;
            await expectStatus(admin.post(payload(f)), 500);
            assert.equal((await tx`SELECT count(*)::int AS n FROM purchase_orders WHERE return_source_order_id=${f.id}`)[0].n, 0);
            assert.equal((await tx`SELECT returned_qty FROM order_items WHERE id=${f.a}`)[0].returned_qty, 0);
            failAudit = false;
            const created = await expectStatus(admin.post(payload(f)), 201);
            const child = created.data.orders.find(order => order.id === created.createdOrderId);
            assert.equal(child.status, "在途"); assert.equal(child.settled, false); assert.equal(child.isReturned, true);
            assert.equal(child.purchaserId, f.actor); assert.equal(child.returnSourceOrderId, f.id); assert.equal(child.returnSourceItemId, f.a); assert.equal(child.returnQuantity, 1);
            assert.equal(child.amount, 3.33); assert.equal(child.courierNo, "RETURN-001"); assert.equal(child.courierCompany, "其他物流");
            assert.equal(child.items[0].sku, f.sku); assert.equal(child.items[0].qty, 1); assert.equal(child.items[0].shipped, false);
            assert.equal(child.approvedAt != null, true); assert.deepEqual(child.settlementProofs, []); assert.deepEqual(child.images, []);
            assert.equal(child.location, undefined); assert.equal(child.receivedAt, undefined); assert.equal(child.settledAmount, undefined);
            const parent = created.data.orders.find(order => order.id === f.id);
            assert.equal(parent.status, "已发货"); assert.equal(parent.settled, true); assert.equal(parent.settledAmount, 14);
            assert.equal(parent.items.find(item => item.id === f.a).returnedQty, 1);
            assert.equal(parent.items.find(item => item.id === f.b).returnedQty, 0);
            assert.equal(parent.items.find(item => item.id === f.a).returnOrders[0].orderId, child.id);
            const after = (await tx`SELECT row_to_json(p) AS row FROM purchase_orders p WHERE id=${f.id}`)[0].row;
            delete before.updated_at; delete after.updated_at; assert.deepEqual(after, before);
            const afterItems = await tx`SELECT row_to_json(i) AS row FROM order_items i WHERE order_id=${f.id} ORDER BY id`;
            for (let index = 0; index < beforeItems.length; index++) {
                delete beforeItems[index].row.updated_at; delete afterItems[index].row.updated_at;
                delete beforeItems[index].row.returned_qty; delete afterItems[index].row.returned_qty;
                assert.deepEqual(afterItems[index], beforeItems[index]);
            }
            assert.equal((await tx`SELECT quantity FROM inventory WHERE sku=${f.sku}`)[0].quantity, 7);
            assert.equal((await tx`SELECT count(*)::int AS n FROM inventory_movements WHERE order_id=${f.id}`)[0].n, 4);
            assert.equal((await tx`SELECT count(*)::int AS n FROM inventory_lots WHERE order_id=${f.id}`)[0].n, 2);
            assert.equal((await tx`SELECT kind FROM order_images WHERE order_id=${f.id}`)[0].kind, "settlement");
            await expectStatus(admin.post(payload(f)), 409); // duplicate channel + new order number rolls back the entire transaction
            assert.equal((await tx`SELECT returned_qty FROM order_items WHERE id=${f.a}`)[0].returned_qty, 1);
            await expectStatus(admin.post({action: "rollback-shipped-order", orderId: f.id}), 409);
            for (const id of [f.id, child.id]) await expectStatus(admin.post({action: "delete-orders", orderIds: [id]}), 409);
            const changedItems = parent.items.map(item => ({...item, amount: item.id === f.a ? 99 : item.amount}));
            await expectStatus(admin.post({action: "update-order", orderId: f.id, platform: "淘宝", platformNo: f.id, items: changedItems}), 409);
            const second = await expectStatus(admin.post(payload(f, {platformNo: `${f.id}_second`})), 201);
            assert.equal(second.data.orders.find(order => order.id === second.createdOrderId).amount, 3.34);
            const third = await expectStatus(admin.post(payload(f, {platformNo: `${f.id}_third`})), 201);
            assert.equal(third.data.orders.find(order => order.id === third.createdOrderId).amount, 3.33);
            await expectStatus(admin.post(payload(f, {platformNo: `${f.id}_excess`})), 409);
            await expectStatus(admin.post(payload(f, {itemId: f.b, qty: 2, platformNo: `${f.id}_other_item`})), 201);
            const buyerData = await (await buyer.get()).json();
            for (const order of buyerData.orders) {
                for (const key of ["returnSourceOrderId", "returnSourceItemId", "returnQuantity", "isReturned"]) assert.equal(key in order, false);
                for (const item of order.items) for (const key of ["returnedQty", "returnOrders", "shippedAt"]) assert.equal(key in item, false);
            }
            await expectStatus(admin.post({action: "settle-order", orderId: child.id, amount: 3.33}), 200);
            await expectStatus(admin.post({action: "receive", orderId: child.id, location: "C3"}), 200);
            assert.equal((await tx`SELECT quantity FROM inventory WHERE sku=${f.sku}`)[0].quantity, 8);
            await expectStatus(admin.post({action: "ship", itemId: child.items[0].id, company: "顺丰", courier: "SF-second-shipment"}), 200);
            assert.equal((await tx`SELECT quantity FROM inventory WHERE sku=${f.sku}`)[0].quantity, 7);
            const again = await expectStatus(admin.post({action: "return-order-item", orderId: child.id, itemId: child.items[0].id, qty: 1, platformNo: `${f.id}_again`, company: "顺丰", courier: "SF-again"}), 201);
            assert.equal(again.data.orders.find(order => order.id === again.createdOrderId).returnSourceOrderId, child.id);
            throw rollback;
        });
    } catch (error) {if (error !== rollback) throw error;}
    console.log("PASS: validation, ownership, proportional cents, original history, stock, lifecycle, privacy, duplicate and audit rollback");

    const f = await client.begin(tx => seed(tx, "concurrent"));
    try {
        const admin = route(bound(client), f.actor);
        const responses = await Promise.all([admin.post(payload(f, {qty: 3, platformNo: `${f.id}_one`})), admin.post(payload(f, {qty: 3, platformNo: `${f.id}_two`}))]);
        assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
        assert.equal((await client`SELECT returned_qty FROM order_items WHERE id=${f.a}`)[0].returned_qty, 3);
        assert.equal((await client`SELECT count(*)::int AS n FROM purchase_orders WHERE return_source_order_id=${f.id}`)[0].n, 1);
        assert.equal((await client`SELECT quantity FROM inventory WHERE sku=${f.sku}`)[0].quantity, 7);
    } finally {
        await client.begin(async tx => {
            await tx`DELETE FROM audit_logs WHERE actor_id=${f.actor}`;
            const children = await tx`SELECT id FROM purchase_orders WHERE return_source_order_id=${f.id}`;
            const ids = [f.id, ...children.map(row => row.id)];
            await tx`DELETE FROM order_images WHERE order_id IN ${tx(ids)}`;
            await tx`DELETE FROM inventory_movements WHERE order_id IN ${tx(ids)}`;
            await tx`DELETE FROM inventory_lots WHERE order_id IN ${tx(ids)}`;
            for (const child of children) {
                await tx`DELETE FROM order_items WHERE order_id=${child.id}`;
                await tx`DELETE FROM purchase_orders WHERE id=${child.id}`;
            }
            await tx`DELETE FROM order_items WHERE order_id=${f.id}`;
            await tx`DELETE FROM purchase_orders WHERE id=${f.id}`;
            await tx`DELETE FROM inventory WHERE sku=${f.sku}`;
            await tx`DELETE FROM users WHERE id=${f.actor}`;
        });
    }
    console.log("PASS: concurrent returns cannot exceed original quantity; isolated fixtures cleaned up");
} finally {await client.end();}
