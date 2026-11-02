import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import postgres from "postgres";
import {drizzle} from "drizzle-orm/postgres-js";
import ts from "typescript";
import * as checklistHelpers from "../lib/shipping-checklist.ts";

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText;
const schema = {};
new Function("require", "exports", compile(await readFile(new URL("../db/schema.ts", import.meta.url), "utf8")))(require, schema);
const source = await readFile(new URL("../app/api/shipping-checklists/route.ts", import.meta.url), "utf8"), code = compile(source);
assert.doesNotMatch(source, /purchaseOrders|orderItems|inventory|inventoryLots|inventoryMovements/, "independent checklists cannot depend on order or inventory models");
if (!process.env.DATABASE_URL || !/test|ci/i.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error("Use a dedicated test/CI database");
const client = postgres(process.env.DATABASE_URL, {max: 4, connection: {statement_timeout: 10000, lock_timeout: 10000}});
const marker = `shipping_checklist_${randomUUID().replaceAll("-", "")}`;
const bound = sql => drizzle(Object.assign(sql, {options: client.options}), {schema});
const rollback = new Error("ROLLBACK_SHIPPING_CHECKLIST_TEST_DATA");
function handlers(db, role, actor) {
    const modules = {
        "@/db": {getDb: () => db}, "@/db/schema": schema, "@/lib/shipping-checklist": checklistHelpers,
        "@/lib/auth": {
            requireAppUser: async () => {if (role === "guest") throw new Response(null, {status: 401}); return {id: actor, role};},
            requireAdmin: user => {if (user.role !== "admin") throw new Response(null, {status: 403});},
            assertSameOrigin: request => {if (request.headers.get("origin") === "http://untrusted.invalid") throw new Response(null, {status: 403});},
            routeError: error => error instanceof Response ? error : Response.json({error: error.message}, {status: 500}),
        },
    };
    const route = {};
    new Function("require", "exports", code)(name => modules[name] ?? require(name), route);
    const write = (method, body, origin) => route[method](new Request("http://localhost/api/shipping-checklists", {
        method, headers: {"content-type": "application/json", ...(origin ? {origin} : {})}, body: typeof body === "string" ? body : JSON.stringify(body),
    }));
    return {get: (query = "") => route.GET(new Request(`http://localhost/api/shipping-checklists${query}`)),
        post: (body, origin) => write("POST", body, origin), patch: (body, origin) => write("PATCH", body, origin)};
}
async function status(promise, expected) {
    const response = await promise, value = await response.json().catch(() => ({}));
    assert.equal(response.status, expected, JSON.stringify(value.error));
    return value;
}
const item = (id, extra = {}) => ({id, sku: "SKU-01", title: "商品名称", size: "XS", qty: 2, note: "礼袋", completed: true, ...extra});
const create = (extra = {}) => ({title: " 测试发货批次 ", sourceText: "1101 17:14:06\nSKU-01 商品名称 XS ×2 礼袋\n合计：2件", sourceTimeText: "1101 17:14:06", declaredTotal: 2, items: [item("one")], ...extra});
try {
    try {
        await client.begin(async tx => {
            const actor = `${marker}_admin`;
            await tx`INSERT INTO users (id,wechat_id,name,password_hash,role) VALUES (${actor},${actor},'发货清单测试','not-a-login-hash','admin')`;
            const db = bound(tx); let failAudit = false;
            const database = {select: db.select.bind(db), transaction: callback => tx.savepoint(scoped => {
                const scopedDb = bound(scoped);
                return callback(new Proxy(scopedDb, {get(target, key) {
                    if (key === "insert" && failAudit) return table => table === schema.auditLogs
                        ? {values: async () => {throw new Error("deliberate audit failure");}} : target.insert(table);
                    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
                }}));
            })};
            const admin = handlers(database, "admin", actor), buyer = handlers(database, "buyer", actor), guest = handlers(database, "guest", actor);
            for (const denied of [buyer, guest]) {
                const expected = denied === buyer ? 403 : 401;
                await status(denied.get(), expected); await status(denied.post(create()), expected);
                await status(denied.patch({id: "missing", version: 1, action: "set-completed", itemId: "one", completed: true}), expected);
            }
            await status(admin.post(create(), "http://untrusted.invalid"), 403);
            await status(admin.patch({}, "http://untrusted.invalid"), 403);
            for (const malformed of ["{", "[]", "null", "123"]) await status(admin.post(malformed), 400);
            for (const patch of [{title: " "}, {title: "x".repeat(101)}, {sourceText: null}, {sourceText: "x".repeat(50001)}, {sourceTimeText: "x".repeat(41)},
                {declaredTotal: -1}, {declaredTotal: 1.5}, {declaredTotal: "2"}, {declaredTotal: 20000001}, {items: []}, {items: [item("one"), item("one")]},
                {items: [item("one", {qty: 0})]}, {items: [item("one", {qty: 1.5})]}, {items: [item("one", {completed: "yes"})]}, {items: [item("one", {sku: "", title: ""})]}]) await status(admin.post(create(patch)), 400);
            const [beforeUntouched] = await tx`SELECT
                (SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY id)::text,'')) FROM purchase_orders p) AS orders,
                (SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY sku,size)::text,'')) FROM inventory i) AS stock,
                (SELECT md5(coalesce(jsonb_agg(to_jsonb(l) ORDER BY item_id)::text,'')) FROM inventory_lots l) AS lots,
                (SELECT md5(coalesce(jsonb_agg(to_jsonb(m) ORDER BY id)::text,'')) FROM inventory_movements m) AS ledger`;
            const baseline = (await tx`SELECT count(*)::int AS n FROM shipping_checklists`)[0].n;
            failAudit = true; await status(admin.post(create()), 500); failAudit = false;
            assert.equal((await tx`SELECT count(*)::int AS n FROM shipping_checklists`)[0].n, baseline, "create and audit roll back together");
            let record = (await status(admin.post(create()), 201)).checklist;
            const id = record.id;
            assert.equal(record.title, "测试发货批次"); assert.equal(record.items[0].completed, false); assert.equal(record.version, 1);
            assert.equal(record.sourceText, create().sourceText); assert.equal(record.createdBy, actor);
            assert.deepEqual((await status(admin.get(`?id=${id}`), 200)).checklist, record, "saved checklist reloads from real PostgreSQL");
            await status(admin.get("?id=missing"), 404); await status(admin.get("?id="), 400);
            for (const query of ["?page=0", "?page=1.5", "?pageSize=50"]) await status(admin.get(query), 400);
            const toggle = patch => ({id, version: record.version, action: "set-completed", itemId: "one", completed: true, ...patch});
            await status(admin.patch(toggle({version: "1"})), 400); await status(admin.patch(toggle({version: 0})), 400);
            await status(admin.patch(toggle({completed: "yes"})), 400); await status(admin.patch(toggle({action: "unknown"})), 400);
            await status(admin.patch(toggle({itemId: "not-in-this-list"})), 404);
            failAudit = true; await status(admin.patch(toggle()), 500); failAudit = false;
            assert.deepEqual((await status(admin.get(`?id=${id}`), 200)).checklist, record);
            record = (await status(admin.patch(toggle()), 200)).checklist;
            assert.equal(record.items[0].completed, true); assert.equal(record.version, 2);
            await status(admin.patch(toggle({version: 1, completed: false})), 409);
            let page = await status(admin.get(), 200), summary = page.checklists.find(row => row.id === id);
            assert.equal(summary.totalQty, 2); assert.equal(summary.completedQty, 2); assert.equal(summary.completedCount, 1);
            assert.equal("sourceText" in summary, false); assert.equal("items" in summary, false);
            record = (await status(admin.patch({id, version: record.version, action: "update", title: "更名清单", sourceText: "forged overwrite",
                items: [...record.items, item("two", {sku: "SKU-02", qty: 3})]}), 200)).checklist;
            assert.equal(record.items[0].completed, true); assert.equal(record.items[1].completed, false); assert.equal(record.sourceText, create().sourceText);
            assert.equal(record.declaredTotal, 2); assert.equal(record.sourceTimeText, "1101 17:14:06");
            const changed = record.items.map(row => ({...row, qty: row.id === "one" ? 1 : row.qty, completed: true}));
            failAudit = true; await status(admin.patch({id, version: record.version, action: "update", title: "failed", items: changed}), 500); failAudit = false;
            assert.deepEqual((await status(admin.get(`?id=${id}`), 200)).checklist, record);
            record = (await status(admin.patch({id, version: record.version, action: "update", title: record.title, items: changed}), 200)).checklist;
            assert.deepEqual(record.items.map(row => row.completed), [false, false], "editing content resets completion and cannot forge flags");
            record = (await status(admin.patch({id, version: record.version, action: "set-completed", itemId: "one", completed: true}), 200)).checklist;
            record = (await status(admin.patch({id, version: record.version, action: "set-completed", itemId: "one", completed: false}), 200)).checklist;
            assert.equal(record.items[0].completed, false);
            await status(admin.patch({id, version: record.version, action: "update", title: "empty", items: []}), 400);
            for (let index = 0; index < 11; index++) await tx`INSERT INTO shipping_checklists (id,title,items,created_by,created_at)
                VALUES (${`${marker}_${index}`},'分页批次',${JSON.stringify([item(`${index}`, {completed: false})])}::jsonb,${actor},${`2099-01-${String(index + 1).padStart(2,"0")}T00:00:00Z`})`;
            page = await status(admin.get(), 200); assert.equal(page.checklists.length, 10); assert.equal(page.total, baseline + 12); assert.equal(page.pageSize, 10);
            const last = await status(admin.get("?page=999"), 200); assert.equal(last.page, last.totalPages); assert.equal(last.totalPages, Math.ceil((baseline + 12) / 10));
            await assert.rejects(tx.savepoint(inner => inner`INSERT INTO shipping_checklists (id,title,items) VALUES (${`${marker}_bad`},'x','{}'::jsonb)`), error => error.code === "23514");
            const [afterUntouched] = await tx`SELECT
                (SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY id)::text,'')) FROM purchase_orders p) AS orders,
                (SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY sku,size)::text,'')) FROM inventory i) AS stock,
                (SELECT md5(coalesce(jsonb_agg(to_jsonb(l) ORDER BY item_id)::text,'')) FROM inventory_lots l) AS lots,
                (SELECT md5(coalesce(jsonb_agg(to_jsonb(m) ORDER BY id)::text,'')) FROM inventory_movements m) AS ledger`;
            assert.deepEqual(afterUntouched, beforeUntouched, "checklist edits/completion never change orders or inventory");
            throw rollback;
        });
    } catch (error) {if (error !== rollback) throw error;}
    console.log("Shipping checklist real PostgreSQL creation, persistence, edits, per-item completion, privacy, pagination, audit rollback and order/stock independence verified.");

    // Committed UUID-only fixtures allow two distinct database connections to verify optimistic concurrency.
    const actor = `${marker}_concurrent_admin`;
    await client`INSERT INTO users (id,wechat_id,name,password_hash,role) VALUES (${actor},${actor},'清单并发测试','not-a-login-hash','admin')`;
    try {
        const admin = handlers(bound(client), "admin", actor);
        const record = (await status(admin.post(create()), 201)).checklist;
        const results = await Promise.all([true, false].map(completed => admin.patch({id: record.id, version: 1, action: "set-completed", itemId: "one", completed})));
        assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
        const saved = (await status(admin.get(`?id=${record.id}`), 200)).checklist;
        assert.equal(saved.version, 2);
        assert.equal((await client`SELECT count(*)::int AS n FROM audit_logs WHERE actor_id=${actor} AND action='complete_shipping_checklist_item'`)[0].n, 1);
    } finally {
        await client.begin(async tx => {
            await tx`DELETE FROM audit_logs WHERE actor_id=${actor}`;
            await tx`DELETE FROM shipping_checklists WHERE created_by=${actor}`;
            await tx`DELETE FROM users WHERE id=${actor}`;
        });
    }
    console.log("Shipping checklist concurrent versions reject one stale write; isolated test fixtures removed.");
} finally {await client.end();}
