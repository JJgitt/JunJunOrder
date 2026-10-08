import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import ts from "typescript";
import { matchProductKnowledge } from "../lib/product-knowledge-match.ts";

const require = createRequire(import.meta.url);
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const routeCode = transpile(await readFile(new URL("../app/api/product-knowledge/route.ts", import.meta.url), "utf8"));
const schema = {};
new Function("require", "exports", transpile(await readFile(new URL("../db/schema.ts", import.meta.url), "utf8")))(require, schema);

async function verifyPagination(tx, suffix) {
  const marker = `pagination-${suffix}`;
  const literalAlias = `literal-${suffix}%_\\/"`;
  const [baseline] = await tx`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE source='historical')::int AS historical FROM product_knowledge`;
  const fixtures = Array.from({ length: 12 }, (_, index) => {
    const number = index + 1;
    return {
      id: `pk_test_${marker}_${String(number).padStart(2, "0")}`,
      title: `${marker} 商品 ${number}`, sku: `${marker}-sku-${number}`,
      aliases: number === 2 ? JSON.stringify([literalAlias]) : number === 3 ? "{broken" : number === 4
        ? JSON.stringify([123456789012, null, { value: `object-${marker}` }, `mixed-${marker}`])
        : number === 5 ? JSON.stringify({ value: `nonarray-${marker}` }) : "[]",
      source: number % 3 === 0 ? "historical" : "manual",
      created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
    };
  });
  await tx`INSERT INTO product_knowledge ${tx(fixtures, "id", "title", "sku", "aliases", "source", "created_at", "updated_at")}`;
  // postgres.begin() omits the root parser options from its scoped SQL client.
  // Keep the reserved transaction connection while supplying Drizzle's parser config.
  const database = drizzle(Object.assign(tx, { options: db.options }), { schema });
  const modules = {
    "@/db": { getDb: () => ({ transaction: callback => callback(database) }) },
    "@/db/schema": schema,
    "@/lib/auth": {
      assertSameOrigin() {}, requireAppUser: async () => ({ id: "ci-admin", role: "admin" }), requireAdmin() {},
      routeError(error) { if (error instanceof Response) return error; throw error; },
    },
  };
  const route = {};
  new Function("require", "exports", routeCode)(id => modules[id] ?? require(id), route);
  const get = async params => {
    const response = await route.GET(new Request(`http://localhost/api/product-knowledge?${new URLSearchParams(params)}`));
    assert.equal(response.status, 200);
    return response.json();
  };
  const expectedIds = fixtures.map(row => row.id).reverse();
  for (const pageSize of [5, 10, 50]) {
    const totalPages = Math.ceil(fixtures.length / pageSize);
    for (let page = 1; page <= totalPages; page++) {
      const data = await get({ q: marker, page: String(page), ...(pageSize === 5 ? {} : { pageSize: String(pageSize) }) });
      assert.deepEqual(data.pagination, { page, pageSize, total: 12, totalPages });
      assert.deepEqual(data.counts, { allTotal: baseline.total + 12, historicalTotal: baseline.historical + 4 });
      assert.deepEqual(data.products.map(row => row.id), expectedIds.slice((page - 1) * pageSize, page * pageSize), "equal timestamps must still have stable page ordering");
    }
  }
  const clamped = await get({ q: marker, page: "9" });
  assert.deepEqual(clamped.pagination, { page: 3, pageSize: 5, total: 12, totalPages: 3 });
  assert.deepEqual(clamped.products.map(row => row.id), expectedIds.slice(10));
  const empty = await get({ q: `missing-${marker}`, page: "9" });
  assert.deepEqual(empty.pagination, { page: 1, pageSize: 5, total: 0, totalPages: 1 });
  assert.deepEqual(empty.products, []);
  for (const [query, fixtureIndex] of [[fixtures[6].title, 6], [fixtures[6].sku.toUpperCase(), 6], [`  ${literalAlias}  `, 1], [`mixed-${marker}`, 3]]) {
    const data = await get({ q: query });
    assert.equal(data.pagination.total, 1);
    assert.deepEqual(data.products.map(row => row.id), [fixtures[fixtureIndex].id]);
  }
  const literal = await get({ q: literalAlias });
  assert.deepEqual(literal.products[0].aliases, [literalAlias], "JSON-escaped punctuation remains searchable as literal alias text");
  for (const query of [`object-${marker}`, `nonarray-${marker}`]) {
    const data = await get({ q: query });
    assert.equal(data.pagination.total, 0, "objects and nonarray alias JSON do not become searchable aliases");
  }
  const malformed = await get({ q: fixtures[2].title });
  assert.deepEqual(malformed.products[0].aliases, [], "malformed legacy alias JSON does not break real SQL search");
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = postgres(process.env.DATABASE_URL, { max: 1 });
const rollback = new Error("ROLLBACK_PRODUCT_KNOWLEDGE_TEST");
try {
  await db.begin(async tx => {
    const suffix = randomUUID().slice(0, 8);
    const title = `维秘波点长袖睡衣${suffix}`;
    const historical = `维秘波点短袖睡衣${suffix}`;
    const manualId = `pk_test_${randomUUID()}`;
    const historicalId = `pk_test_${randomUUID()}`;
    await tx`INSERT INTO product_knowledge (id,title,sku,aliases,source)
      VALUES (${manualId},${title},${`VS-${suffix}`},${JSON.stringify([`波点长袖${suffix}`])},'manual')`;
    await tx`INSERT INTO product_knowledge (id,title,sku,aliases,source)
      VALUES (${historicalId},${historical},${`VS-S-${suffix}`},'[]','historical')`;
    const rows = await tx`SELECT id,title,sku,aliases,source FROM product_knowledge WHERE id IN (${manualId},${historicalId})`;
    const products = rows.map(row => ({ ...row, aliases: JSON.parse(row.aliases) }));
    assert.equal(matchProductKnowledge({ title, sku: title, skuSource: "title" }, products).kind, "auto");
    assert.equal(matchProductKnowledge({ title: historical, sku: historical, skuSource: "title" }, products).kind, "suggestion");
    await assert.rejects(tx.savepoint(() => tx`INSERT INTO product_knowledge (id,title,sku,source)
      VALUES (${`pk_test_${randomUUID()}`},${title},${`VS-${suffix}`},'manual')`), error => error.code === "23505");
    await verifyPagination(tx, suffix);
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
  console.log("Product knowledge migration, source rules, uniqueness and real SQL pagination/search verified; fixtures rolled back.");
} finally {
  await db.end();
}
