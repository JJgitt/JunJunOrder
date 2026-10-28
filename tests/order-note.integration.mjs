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
const client = postgres(process.env.DATABASE_URL, {max: 1, connection: {statement_timeout: 10000, lock_timeout: 10000}});
const marker = `note_test_${randomUUID().replaceAll("-", "")}`;
const migration = await readFile(new URL("../drizzle/0020_purchase_order_admin_note.sql", import.meta.url), "utf8");
const bound = sql => drizzle(Object.assign(sql, {options: client.options}), {schema});
const stamp = "2026-10-28T04:00:00.000Z";
function handler(db, user) {
    const modules = {
        "@/db": {getDb: () => db}, "@/db/schema": schema,
        "@/lib/auth": {
            assertSameOrigin() {}, requireAppUser: async () => user,
            requireAdmin: actor => {if (actor.role !== "admin") throw new Response(null, {status: 403});},
            routeError: error => error instanceof Response ? error : Response.json({error: error.message}, {status: (error.code ?? error.cause?.code) === "23505" ? 409 : 500}),
        },
        "@/lib/server-time": {serverClock: () => ({now: stamp, timeZone: "Asia/Shanghai"})},
        "@/lib/time": time, "@/lib/order-settlement": settlement, "@/lib/file-storage": {uploadPath: key => key},
    };
    const route = {};
    new Function("require", "exports", code)(name => modules[name] ?? require(name), route);
    return {
        post: body => route.POST(new Request("http://localhost/api/app", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)})),
        get: () => route.GET(new Request("http://localhost/api/app")),
    };
}
async function expectStatus(promise, status) {
    const response = await promise, json = await response.json().catch(() => ({}));
    assert.equal(response.status, status, JSON.stringify(json.error));
    return json;
}
const rollback = new Error("ROLLBACK_NOTE_FIXTURES");
try {
    try {
        await client.begin(async tx => {
            // Re-run the actual migration on a pre-column schema inside transactional DDL.
            try {
                await tx.savepoint(async scoped => {
                    await scoped`ALTER TABLE purchase_orders DROP COLUMN admin_note`;
                    await scoped`INSERT INTO users (id,wechat_id,name,password_hash,role)
                        VALUES (${marker},${marker},'备注迁移测试','not-a-login-hash','admin')`;
                    await scoped`INSERT INTO purchase_orders (id,platform,platform_order_no,purchaser_id,status,created_at,updated_at)
                        VALUES (${marker},'淘宝',${marker},${marker},'在途',${stamp},${stamp})`;
                    const before = (await scoped`SELECT to_jsonb(p) AS row FROM purchase_orders p WHERE id=${marker}`)[0].row;
                    await scoped.unsafe(migration);
                    const [column] = await scoped`SELECT data_type,is_nullable,column_default FROM information_schema.columns
                        WHERE table_schema=current_schema() AND table_name='purchase_orders' AND column_name='admin_note'`;
                    assert.equal(column.data_type, "text"); assert.equal(column.is_nullable, "NO"); assert.match(column.column_default, /''/);
                    const after = (await scoped`SELECT to_jsonb(p) AS row FROM purchase_orders p WHERE id=${marker}`)[0].row;
                    assert.equal(after.admin_note, ""); delete after.admin_note; assert.deepEqual(after, before);
                    await assert.rejects(scoped.savepoint(inner => inner`UPDATE purchase_orders SET admin_note=null WHERE id=${marker}`), error => error.code === "23502");
                    await assert.rejects(scoped.savepoint(inner => inner`UPDATE purchase_orders SET admin_note=${"字".repeat(1001)} WHERE id=${marker}`), error => error.code === "23514");
                    await scoped`UPDATE purchase_orders SET admin_note=${"字".repeat(1000)} WHERE id=${marker}`;
                    throw rollback;
                });
            } catch (error) {if (error !== rollback) throw error;}

            const admin = {id: `${marker}_admin`, role: "admin", name: "管理员"};
            const buyer = {id: `${marker}_buyer`, role: "buyer", name: "采购员"};
            for (const user of [admin, buyer]) await tx`INSERT INTO users (id,wechat_id,name,password_hash,role)
                VALUES (${user.id},${user.id},${user.name},'not-a-login-hash',${user.role})`;
            const database = bound(tx); let failAudit = false;
            const db = {select: database.select.bind(database), transaction: callback => tx.savepoint(scoped => {
                const scopedDb = bound(scoped);
                return callback(new Proxy(scopedDb, {get(target, key) {
                    if (key === "insert" && failAudit) return table => table === schema.auditLogs
                        ? {values: async () => {throw new Error("deliberate audit failure");}} : target.insert(table);
                    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
                }}));
            })};
            const adminRoute = handler(db, admin), buyerRoute = handler(db, buyer);
            const item = {title: "备注商品", sku: `${marker}_sku`, size: "M", qty: 2, amount: 100, purchaseCourierCompany: "顺丰", purchaseCourierNo: "SF-note"};
            const created = await expectStatus(adminRoute.post({action: "create-order", platform: "淘宝", platformNo: marker, purchaserId: buyer.id, items: [item], adminNote: "create must ignore this"}), 201);
            const id = created.createdOrderId;
            const note = async () => (await tx`SELECT admin_note FROM purchase_orders WHERE id=${id}`)[0].admin_note;
            const visible = async () => (await expectStatus(adminRoute.get(), 200)).orders.find(order => order.id === id);
            const edit = async patch => ({action: "update-order", orderId: id, platform: "淘宝", platformNo: marker,
                items: (await tx`SELECT * FROM order_items WHERE order_id=${id}`).map(row => ({id: row.id, title: row.title, sku: row.sku, size: row.size, qty: row.qty, amount: row.amount_cents / 100,
                    purchaseCourierCompany: row.purchase_courier_company, purchaseCourierNo: row.purchase_courier_no})), ...patch});
            assert.equal(await note(), ""); assert.equal((await visible()).adminNote, "");
            const content = "核对售后\n<script>alert('test')</script> & 第二行";
            await expectStatus(adminRoute.post(await edit({adminNote: `  ${content}  `})), 200);
            assert.equal(await note(), content); assert.equal((await visible()).adminNote, content);
            const [audit] = await tx`SELECT detail_json FROM audit_logs WHERE entity_id=${id} AND action='update'`;
            assert.equal(JSON.parse(audit.detail_json).before.adminNote, ""); assert.equal(JSON.parse(audit.detail_json).after.adminNote, content);
            const beforeValidation = await tx`SELECT to_jsonb(p) AS row FROM purchase_orders p WHERE id=${id}`;
            const auditCount = (await tx`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=${id}`)[0].n;
            for (const value of [null, 123, true, [], {}, "字".repeat(1001)]) await expectStatus(adminRoute.post(await edit({adminNote: value})), 400);
            assert.deepEqual(await tx`SELECT to_jsonb(p) AS row FROM purchase_orders p WHERE id=${id}`, beforeValidation);
            assert.equal((await tx`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=${id}`)[0].n, auditCount);
            await expectStatus(adminRoute.post(await edit({})), 200); assert.equal(await note(), content, "older clients preserve existing notes");
            await expectStatus(adminRoute.post(await edit({adminNote: "字".repeat(1000)})), 200); assert.equal((await note()).length, 1000);
            await expectStatus(adminRoute.post(await edit({adminNote: " \n "})), 200); assert.equal(await note(), "", "whitespace clears the note");
            await expectStatus(adminRoute.post(await edit({adminNote: content})), 200);
            failAudit = true;
            const failed = await edit({adminNote: "must roll back"}); failed.items[0].title = "must also roll back";
            await expectStatus(adminRoute.post(failed), 500); failAudit = false;
            assert.equal(await note(), content); assert.equal((await visible()).items[0].title, item.title);
            await expectStatus(buyerRoute.post(await edit({adminNote: "buyer override"})), 403);
            const ownEdit = await edit({action: "resubmit-order", adminNote: "buyer override"});
            await expectStatus(buyerRoute.post(ownEdit), 200); assert.equal(await note(), content);
            const buyerVisible = (await expectStatus(buyerRoute.get(), 200)).orders.find(order => order.id === id);
            assert.equal("adminNote" in buyerVisible, false, "owning buyer never receives the note");
            const buyerCreated = await expectStatus(buyerRoute.post({action: "create-order", platform: "淘宝", platformNo: `${marker}_buyer_create`, items: [item], adminNote: content}), 201);
            assert.equal((await tx`SELECT admin_note FROM purchase_orders WHERE id=${buyerCreated.createdOrderId}`)[0].admin_note, "");
            await expectStatus(adminRoute.post({action: "approve", orderId: id}), 200);
            await expectStatus(adminRoute.post({action: "receive", orderId: id, location: "N1"}), 200); assert.equal(await note(), content);
            const stockBefore = await tx`SELECT quantity FROM inventory WHERE sku=${item.sku}`;
            const ledgerBefore = await tx`SELECT count(*)::int AS n FROM inventory_movements WHERE order_id=${id}`;
            await expectStatus(adminRoute.post(await edit({adminNote: "已入库备注"})), 200);
            assert.deepEqual(await tx`SELECT quantity FROM inventory WHERE sku=${item.sku}`, stockBefore);
            assert.deepEqual(await tx`SELECT count(*)::int AS n FROM inventory_movements WHERE order_id=${id}`, ledgerBefore);
            await expectStatus(adminRoute.post({action: "revert-receive", orderId: id}), 200); assert.equal(await note(), "已入库备注");
            await expectStatus(adminRoute.post({action: "settle-order", orderId: id, amount: 100}), 200);
            await expectStatus(adminRoute.post({action: "receive", orderId: id, location: "N2"}), 200);
            const shipmentItem = (await visible()).items[0].id;
            await expectStatus(adminRoute.post({action: "ship", itemId: shipmentItem, company: "京东", courier: "JD-note"}), 200);
            await expectStatus(adminRoute.post(await edit({adminNote: "已发货备注"})), 200);
            assert.equal((await visible()).settled, true); assert.equal((await visible()).status, "已发货");
            await expectStatus(adminRoute.post({action: "rollback-shipped-order", orderId: id}), 200); assert.equal(await note(), "已发货备注");
            await expectStatus(adminRoute.post({action: "receive", orderId: id, location: "N3"}), 200);
            await expectStatus(adminRoute.post({action: "ship", itemId: shipmentItem, company: "京东", courier: "JD-again"}), 200);
            const returned = await expectStatus(adminRoute.post({action: "return-order-item", orderId: id, itemId: shipmentItem, qty: 1, platformNo: `${marker}_returned`, company: "顺丰", courier: "SF-return"}), 201);
            assert.equal(await note(), "已发货备注");
            assert.equal(returned.data.orders.find(order => order.id === returned.createdOrderId).adminNote, "", "new child does not inherit private notes");
            throw rollback;
        });
    } catch (error) {if (error !== rollback) throw error;}
    assert.equal((await client`SELECT count(*)::int AS n FROM users WHERE id LIKE ${`${marker}%`}`)[0].n, 0);
    console.log("Order-note migration, actual handler persistence/clearing, validation, privacy, legacy clients, audit rollback and lifecycle retention verified; fixtures rolled back.");
} finally {await client.end();}
