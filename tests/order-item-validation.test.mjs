import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const user = { id: "admin", role: "admin" };
const modules = {
  "@/db": { getDb: () => ({ transaction: () => { throw new Error("Invalid input reached the database"); } }) },
  "@/db/schema": {},
  "@/lib/auth": { assertSameOrigin: () => {}, requireAdmin: () => {}, requireAppUser: async () => user, routeError: error => { throw error; } },
  "@/lib/file-storage": {},
  "@/lib/server-time": {},
  "@/lib/time": {},
};
const route = {};
new Function("require", "exports", code)(id => modules[id] ?? require(id), route);

const validItem = { title: "商品", sku: "SKU-1", size: "M", qty: 1, amount: 100, purchaseCourierCompany: "顺丰", purchaseCourierNo: "SF123" };

async function submit(action, items) {
  const response = await route.POST(new Request("http://localhost/api/app", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, orderId: "existing-order", platform: "淘宝", platformNo: "T1", items }),
  }));
  return { status: response.status, body: await response.json() };
}

test("order actions reject non-finite and out-of-range item numbers before database writes", async () => {
  for (const action of ["create-order", "resubmit-order", "update-order"]) {
    for (const patch of [
      { amount: "not-a-number" }, { amount: "Infinity" }, { amount: 21_474_836.48 },
      { qty: "Infinity" }, { qty: 2_147_483_648 }, { qty: 0 }, { qty: -2 }, { qty: 1.5 },
    ]) {
      const result = await submit(action, [{ ...validItem, ...patch }]);
      assert.equal(result.status, 400, `${action}: ${JSON.stringify(patch)}`);
      assert.match(result.body.error, /数量与金额/);
    }
  }
});

test("order actions reject more than 20 items instead of silently dropping extras", async () => {
  for (const action of ["create-order", "resubmit-order", "update-order"]) {
    const result = await submit(action, Array.from({ length: 21 }, (_, index) => ({ ...validItem, sku: `SKU-${index}` })));
    assert.equal(result.status, 400, action);
    assert.match(result.body.error, /最多录入 20 个商品/);
  }
});

test("order actions reject duplicate item IDs before inventory updates", async () => {
  for (const action of ["create-order", "resubmit-order", "update-order"]) {
    const result = await submit(action, [{ ...validItem, id: "same-item" }, { ...validItem, id: "same-item" }]);
    assert.equal(result.status, 400, action);
    assert.match(result.body.error, /商品行不能重复提交/);
  }
});
