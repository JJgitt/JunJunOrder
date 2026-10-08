import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { drizzle } from "drizzle-orm/postgres-js";

const require = createRequire(import.meta.url);
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const routeCode = transpile(await readFile(new URL("../app/api/product-knowledge/route.ts", import.meta.url), "utf8"));
const schemaCode = transpile(await readFile(new URL("../db/schema.ts", import.meta.url), "utf8"));
const schema = {};
new Function("require", "exports", schemaCode)(require, schema);
const admin = { id: "admin", role: "admin" };

function fixture(index) {
  return {
    id: `pk-${index}`, title: `商品 ${index}`, sku: `SKU-${index}`, aliases: JSON.stringify([`别名 ${index}`]),
    source: index % 2 ? "manual" : "historical", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
  };
}

async function getCatalog(query = "", { total = 12, allTotal = total, historicalTotal = 3, user = admin, rows } = {}) {
  const events = [];
  const queries = [];
  const products = rows ?? Array.from({ length: total }, (_, index) => fixture(index + 1));
  const realDb = drizzle.mock();
  const tx = {
    select(selection) {
      const select = realDb.select(selection);
      return { from(table) {
        assert.equal(table, schema.productKnowledge);
        let realQuery = select.from(table);
        const record = { aggregate: Boolean(selection), limit: undefined, offset: 0 };
        const builder = {
          where(condition) { realQuery = realQuery.where(condition); return builder; },
          orderBy(...order) { realQuery = realQuery.orderBy(...order); return builder; },
          limit(value) { record.limit = value; realQuery = realQuery.limit(value); return builder; },
          offset(value) { record.offset = value; realQuery = realQuery.offset(value); return builder; },
          then(resolve, reject) {
            queries.push({ ...record, ...realQuery.toSQL() });
            const result = selection ? [{ allTotal, historicalTotal, total }] : products.slice(record.offset, record.offset + record.limit);
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return builder;
      } };
    },
  };
  const db = {
    transaction(callback, options) {
      events.push({ type: "transaction", options });
      return callback(tx);
    },
  };
  const modules = {
    "@/db": { getDb() { events.push({ type: "database" }); return db; } },
    "@/db/schema": schema,
    "@/lib/auth": {
      assertSameOrigin() {},
      async requireAppUser() {
        events.push({ type: "authenticate" });
        if (!user) throw Response.json({ error: "请先登录" }, { status: 401 });
        return user;
      },
      requireAdmin(person) {
        events.push({ type: "authorize" });
        if (person.role !== "admin") throw Response.json({ error: "需要管理员权限" }, { status: 403 });
      },
      routeError(error) { if (error instanceof Response) return error; throw error; },
    },
  };
  const route = {};
  new Function("require", "exports", routeCode)(id => modules[id] ?? require(id), route);
  const response = await route.GET(new Request(`http://localhost/api/product-knowledge${query ? `?${query}` : ""}`));
  return { response, data: await response.json(), events, queries };
}

test("catalog GET defaults to five rows and returns global counts in one stable read snapshot", async () => {
  const { response, data, events, queries } = await getCatalog();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(data.pagination, { page: 1, pageSize: 5, total: 12, totalPages: 3 });
  assert.deepEqual(data.counts, { allTotal: 12, historicalTotal: 3 });
  assert.deepEqual(data.products.map(row => row.id), ["pk-1", "pk-2", "pk-3", "pk-4", "pk-5"]);
  assert.deepEqual(data.products[0].aliases, ["别名 1"]);
  assert.deepEqual(events.map(event => event.type), ["authenticate", "authorize", "database", "transaction"]);
  assert.deepEqual(events.at(-1).options, { isolationLevel: "repeatable read", accessMode: "read only" });
  assert.equal(queries.length, 2);
  assert.equal(queries[0].aggregate, true);
  assert.equal(queries[1].limit, 5);
  assert.equal(queries[1].offset, 0);
  assert.match(queries[1].sql, /order by "product_knowledge"\."updated_at" desc, "product_knowledge"\."id" desc/);
});

test("catalog GET applies each supported page size and page offset in SQL", async () => {
  for (const pageSize of [5, 10, 50]) {
    const { response, data, queries } = await getCatalog(`page=2&pageSize=${pageSize}`, { total: 121 });
    assert.equal(response.status, 200);
    assert.deepEqual(data.pagination, { page: 2, pageSize, total: 121, totalPages: Math.ceil(121 / pageSize) });
    assert.equal(data.products.length, pageSize);
    assert.equal(data.products[0].id, `pk-${pageSize + 1}`);
    assert.equal(queries[1].limit, pageSize);
    assert.equal(queries[1].offset, pageSize);
    assert.match(queries[1].sql, /limit \$\d+ offset \$\d+/);
    assert.deepEqual(queries[1].params.slice(-2), [pageSize, pageSize]);
  }
});

test("catalog GET rejects malformed pages, unsupported sizes and overlong queries before querying the database", async () => {
  const invalid = [
    "page=0", "page=-1", "page=1.5", "page=NaN", "page=9007199254740992", "page=2147483648",
    "pageSize=0", "pageSize=6", "pageSize=20", "pageSize=500", "pageSize=NaN", "pageSize=5.5",
    `q=${"a".repeat(201)}`,
  ];
  for (const query of invalid) {
    const { response, events, queries } = await getCatalog(query);
    assert.equal(response.status, 400, query);
    assert.equal(events.some(event => event.type === "database"), false, query);
    assert.equal(queries.length, 0, query);
  }
  const valid = await getCatalog(`q=${"a".repeat(200)}&page=2147483647`);
  assert.equal(valid.response.status, 200);
  assert.equal(valid.data.pagination.page, 3, "largest supported page clamps to the last populated page");
});

test("catalog GET clamps a stale last page after deletion and skips row lookup when the search has no matches", async () => {
  const lastPage = await getCatalog("page=9&pageSize=5", { total: 11 });
  assert.equal(lastPage.response.status, 200);
  assert.deepEqual(lastPage.data.pagination, { page: 3, pageSize: 5, total: 11, totalPages: 3 });
  assert.deepEqual(lastPage.data.products.map(row => row.id), ["pk-11"]);
  assert.equal(lastPage.queries[1].offset, 10);

  const empty = await getCatalog("q=没有商品&page=9", { total: 0, allTotal: 42, historicalTotal: 8 });
  assert.equal(empty.response.status, 200);
  assert.deepEqual(empty.data.pagination, { page: 1, pageSize: 5, total: 0, totalPages: 1 });
  assert.deepEqual(empty.data.products, []);
  assert.deepEqual(empty.data.counts, { allTotal: 42, historicalTotal: 8 });
  assert.equal(empty.queries.length, 1, "empty results do not run a row query");
});

test("catalog GET searches all records with a literal parameterized name, SKU and alias condition", async () => {
  const keyword = "维秘_50%\\波点";
  const query = new URLSearchParams({ q: `  ${keyword}  `, page: "2" });
  const { response, data, queries } = await getCatalog(query.toString(), { total: 6, allTotal: 80 });
  assert.equal(response.status, 200);
  assert.equal(data.pagination.total, 6);
  assert.equal(data.counts.allTotal, 80);
  assert.equal(data.products[0].id, "pk-6");
  for (const sqlQuery of queries) {
    assert.match(sqlQuery.sql, /"title"/);
    assert.match(sqlQuery.sql, /"sku"/);
    assert.match(sqlQuery.sql, /"aliases"/);
    assert.equal(sqlQuery.sql.includes(keyword), false, "search values must remain query parameters");
    assert.match(sqlQuery.sql, /strpos\(lower\(/, "literal substring queries must not interpret SQL wildcard characters");
    assert.ok(sqlQuery.params.includes(keyword), "trimmed search values must retain literal wildcard and backslash characters");
  }
});

test("catalog GET keeps malformed legacy aliases harmless and ignores nonstring aliases", async () => {
  const rows = [
    { ...fixture(1), aliases: "{broken" },
    { ...fixture(2), aliases: JSON.stringify(["正确别名", 123, null, { name: "错误别名" }]) },
    { ...fixture(3), aliases: JSON.stringify({ name: "不是数组" }) },
  ];
  const { response, data, queries } = await getCatalog("q=正确别名", { total: rows.length, rows });
  assert.equal(response.status, 200);
  assert.deepEqual(data.products.map(row => row.aliases), [[], ["正确别名"], []]);
  assert.match(queries[1].sql, /case when [\s\S]*?is json array then [\s\S]*?else '\[\]'::jsonb end/);
  assert.match(queries[1].sql, /jsonb_typeof\(alias\.value\) = 'string'/);
});

test("catalog GET blocks anonymous and buyer users before inspecting query values or querying data", async () => {
  for (const [user, status] of [[null, 401], [{ id: "buyer", role: "buyer" }, 403]]) {
    const { response, queries, events } = await getCatalog("page=0&pageSize=500", { user });
    assert.equal(response.status, status);
    assert.equal(queries.length, 0);
    assert.equal(events.some(event => event.type === "database"), false);
  }
});
