import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRecognition } from "../lib/vision.ts";

test("missing, null, empty and whitespace SKUs fall back to trimmed product names", () => {
  for (const sku of [undefined, null, "", "   "]) {
    const result = normalizeRecognition({items:[{title:"  李宁追风跑步鞋  ",sku}]});
    assert.equal(result.items[0].sku, "李宁追风跑步鞋");
  }
});

test("recognized SKUs are preserved and each item falls back independently", () => {
  const result = normalizeRecognition({items:[{title:"鞋款一",sku:" AB123-01 "},{title:"鞋款二"}]});
  assert.deepEqual(result.items.map(item => item.sku), ["AB123-01", "鞋款二"]);
});

test("missing names and SKUs are not invented", () => {
  const result = normalizeRecognition({items:[{title:"",sku:"",size:"42"},{}]});
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].sku, "");
});
