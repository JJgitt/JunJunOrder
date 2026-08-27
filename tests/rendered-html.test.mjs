import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the production application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>骏骏订单｜多渠道采购转卖管理<\/title>/i);
  assert.match(html, /正在连接业务数据/);
  assert.match(html, /正在验证登录状态并载入订单、库存与权限/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/i);
});

test("ships persistent storage bindings and schema migration", async () => {
  const [hosting, migration, api, schema] = await Promise.all([
    readFile(new URL("../dist/.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../dist/.openai/drizzle/0000_sleepy_the_phantom.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  assert.deepEqual(JSON.parse(hosting), {
    project_id: "appgprj_6a8584e05c108191ab6574c26447ce9a",
    d1: "DB",
    r2: "FILES",
  });
  for (const table of ["users", "purchase_orders", "inventory", "inventory_lots", "inventory_movements", "order_images", "audit_logs"]) {
    assert.match(migration, new RegExp(`CREATE TABLE [\\\"\\\`]${table}[\\\"\\\`]`));
  }
  assert.match(migration, /PRAGMA optimize/);
  assert.match(api, /requireAppUser|requireAdmin|d1\.batch/);
  assert.match(schema, /uniqueIndex|primaryKey/);
});
