import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRecognition, normalizeSettlementAmount } from "../lib/vision.ts";

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

test("waybill prompt asks the model for courier fields only", async () => {
  const { waybillPrompt } = await import("../lib/vision.ts");
  assert.match(waybillPrompt, /只认面单上的运单号/);
  assert.match(waybillPrompt, /不要把手机号、订单号/);
});

test("courier-only screenshots keep items empty and preserve tracking fields", () => {
  const result = normalizeRecognition({
    platform: "",
    platformNo: "",
    courierCompany: "中通快递",
    courierNo: "7720 1234 5678",
    items: [],
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.courierCompany, "中通快递");
  assert.equal(result.courierNo, "772012345678");
});

test("settlement amount normalization accepts currency text and rejects missing or non-positive values", () => {
  assert.equal(normalizeSettlementAmount({ amount: "¥1,288.50" }), 1288.5);
  assert.equal(normalizeSettlementAmount({ transferAmount: 399 }), 399);
  assert.equal(normalizeSettlementAmount({ amount: null }), null);
  assert.equal(normalizeSettlementAmount({ amount: 0 }), null);
});
