import assert from "node:assert/strict";
import test from "node:test";
import { fillProductIdentity } from "../lib/product-knowledge-fill.ts";

const screenshot = { title: "维秘波点…", sku: "夜影黑", skuSource: "specification", size: "M", qty: 2, amount: 258, courierNo: "JD123" };
const candidate = { id: "pk-1", title: "维秘波点长袖睡衣", sku: "VS-BD-001", score: 0.91 };

test("a confirmed unique match fills product identity without copying order-specific fields", () => {
  assert.deepEqual(fillProductIdentity(screenshot, { kind: "auto", candidates: [candidate] }), {
    ...screenshot, title: candidate.title, sku: candidate.sku,
  });
});

test("suggestions and missing evidence preserve specification and title fallback values", () => {
  const suggestion = { kind: "suggestion", candidates: [candidate] };
  assert.equal(fillProductIdentity(screenshot, suggestion), screenshot);
  assert.equal(fillProductIdentity(screenshot, { kind: "none", candidates: [] }), screenshot);
  const titleFallback = { ...screenshot, sku: screenshot.title, skuSource: "title" };
  assert.equal(fillProductIdentity(titleFallback, undefined), titleFallback);
});

test("an explicit screenshot SKU is not overwritten by a title match", () => {
  const item = { ...screenshot, sku: "AB123", skuSource: "explicit" };
  assert.deepEqual(fillProductIdentity(item, { kind: "auto", candidates: [candidate] }), { ...item, title: candidate.title });
});
