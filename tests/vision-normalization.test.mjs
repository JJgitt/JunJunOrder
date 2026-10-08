import assert from "node:assert/strict";
import test from "node:test";
import { isVisionTimeout, normalizeRecognition, normalizeSettlementAmount, recognizeOrderImage, visionPrompt } from "../lib/vision.ts";

test("vision timeouts are classified without treating unrelated errors as timeouts", () => {
  assert.equal(isVisionTimeout(Object.assign(new Error("request expired"), { name: "TimeoutError" })), true);
  assert.equal(isVisionTimeout(Object.assign(new Error("request aborted"), { name: "AbortError" })), true);
  assert.equal(isVisionTimeout(Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("socket timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
  })), true);
  assert.equal(isVisionTimeout(new Error("invalid model JSON")), false);
});

test("order recognition treats upstream HTTP and response-body timeouts alike", async () => {
  const previousFetch = globalThis.fetch;
  const previousConfig = {
    base: process.env.VISION_API_BASE,
    key: process.env.VISION_API_KEY,
    model: process.env.VISION_MODEL,
  };
  process.env.VISION_API_BASE = "https://example.invalid/v1";
  process.env.VISION_API_KEY = "test-only";
  process.env.VISION_MODEL = "test-model";
  const image = new File([Uint8Array.of(1)], "order.jpg", { type: "image/jpeg" });
  try {
    for (const status of [408, 504]) {
      globalThis.fetch = async () => new Response(null, { status });
      await assert.rejects(recognizeOrderImage(image), error => isVisionTimeout(error));
    }
    const bodyTimeout = Object.assign(new Error("body timed out"), { name: "TimeoutError" });
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw bodyTimeout; } });
    await assert.rejects(recognizeOrderImage(image), error => error === bodyTimeout);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of [
      ["VISION_API_BASE", previousConfig.base],
      ["VISION_API_KEY", previousConfig.key],
      ["VISION_MODEL", previousConfig.model],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("recognized unit paid amounts become each product line's total paid amount", () => {
  const result = normalizeRecognition({ items: [
    { title: "羽绒服", size: "M", qty: 2, amount: 279 },
    { title: "羽绒服", size: "L", qty: 3, amount: 129.99 },
    { title: "跑鞋", qty: 1, amount: "¥439.50" },
  ] });
  assert.deepEqual(result.items.map(item => ({ qty: item.qty, amount: item.amount })), [
    { qty: 2, amount: 558 },
    { qty: 3, amount: 389.97 },
    { qty: 1, amount: 439.5 },
  ]);
});

test("missing or invalid recognized paid amounts remain unknown for multi-piece lines", () => {
  for (const amount of [undefined, null, "", "¥", "￥，", "金额不明", -1, Infinity]) {
    const result = normalizeRecognition({ items: [{ title: "外套", qty: 2, amount }] });
    assert.equal(result.items[0].amount, null);
    assert.equal(result.items[0].qty, 2);
  }
});

test("line totals round only after quantity multiplication, preserving derived unit prices", () => {
  const result = normalizeRecognition({ items: [
    { title: "两件套", qty: 2, amount: 323.995 },
    { title: "三件套", qty: 3, amount: 100 / 3 },
    { title: "赠品", qty: 2, amount: 0 },
  ] });
  assert.deepEqual(result.items.map(item => item.amount), [647.99, 100, 0]);
});

test("unrepresentable line paid totals stay unknown instead of overflowing stored integer cents", () => {
  const result = normalizeRecognition({ items: [
    { title: "合法上限", qty: 1, amount: 21474836.47 },
    { title: "总额超限", qty: 2, amount: 21474836.47 },
    { title: "单价超限", qty: 1, amount: 21474836.48 },
    { title: "异常大数", qty: 2, amount: Number.MAX_VALUE },
  ] });
  assert.deepEqual(result.items.map(item => item.amount), [21474836.47, null, null, null]);
});

test("recognized quantities default to one before calculating the line paid total", () => {
  for (const qty of [undefined, null, 0, -2, "未知", Infinity]) {
    const result = normalizeRecognition({ items: [{ title: "睡衣", qty, amount: 129.99 }] });
    assert.equal(result.items[0].qty, 1);
    assert.equal(result.items[0].amount, 129.99);
  }
  const result = normalizeRecognition({ items: [{ title: "睡衣", qty: "2", amount: 129.99 }] });
  assert.equal(result.items[0].qty, 2);
  assert.equal(result.items[0].amount, 259.98);
});

test("successful order recognition requests unit prices and converts them to line totals once", async () => {
  const previousFetch = globalThis.fetch;
  const previousConfig = {
    base: process.env.VISION_API_BASE,
    key: process.env.VISION_API_KEY,
    model: process.env.VISION_MODEL,
  };
  process.env.VISION_API_BASE = "https://example.invalid/v1";
  process.env.VISION_API_KEY = "test-only";
  process.env.VISION_MODEL = "test-model";
  const image = new File([Uint8Array.of(1)], "order.jpg", { type: "image/jpeg" });
  let requestedPrompt;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://example.invalid/v1/chat/completions");
      const request = JSON.parse(options.body);
      requestedPrompt = request.messages.find(message => message.role === "system").content;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ items: [
        { title: "同款外套", qty: 2, amount: 279 },
        { title: "长袖睡衣", qty: 3, amount: 129.99 },
      ] }) } }] });
    };
    const result = await recognizeOrderImage(image);
    assert.deepEqual(result.items.map(item => item.amount), [558, 389.97]);
    assert.equal(requestedPrompt, visionPrompt);
    assert.match(requestedPrompt, /单件.*实付|实付.*单件/s);
    assert.match(requestedPrompt, /不要.*乘.*数量|不.*乘.*数量/s);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of [
      ["VISION_API_BASE", previousConfig.base],
      ["VISION_API_KEY", previousConfig.key],
      ["VISION_MODEL", previousConfig.model],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

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

test("non-size specification text becomes the SKU when no explicit SKU was recognized", () => {
  const result = normalizeRecognition({items:[
    {title:"轻舒绒睡衣",sku:"",size:"颜色分类：夜影黑 / 尺码：M"},
    {title:"复古跑鞋",size:"奶油白、41.5"},
    {title:"羽绒服",size:"款式：短款；XL"},
    {title:"尺码参考表",size:"M/L/XL"},
  ]});
  assert.deepEqual(result.items.map(item => ({sku:item.sku,size:item.size})), [
    {sku:"夜影黑",size:"M"},
    {sku:"奶油白",size:"41.5"},
    {sku:"短款",size:"XL"},
    {sku:"尺码参考表",size:"M/L/XL"},
  ]);
});

test("explicit SKUs win over specification descriptions and plain sizes still fall back to titles", () => {
  const result = normalizeRecognition({items:[
    {title:"跑鞋",sku:"AB123",size:"夜影黑 / 42"},
    {title:"针织衫",sku:"",size:"L"},
  ]});
  assert.deepEqual(result.items.map(item => ({sku:item.sku,size:item.size})), [
    {sku:"AB123",size:"42"},
    {sku:"针织衫",size:"L"},
  ]);
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
