import assert from "node:assert/strict";
import test from "node:test";
import { aggregateCopyLines, buildOrderCopyText, copyTimestamp, formatCopyLine } from "../lib/order-copy.ts";

const now = Date.parse("2026-09-19T06:05:09Z"); // 北京时间 09-19 14:05:09

test("copy text header uses server time zone as MMDD HH:mm:ss", () => {
  assert.equal(copyTimestamp(now, "Asia/Shanghai"), "0919 14:05:09");
  assert.equal(copyTimestamp(now, "UTC"), "0919 06:05:09");
  assert.equal(copyTimestamp(Date.parse("2026-12-31T15:59:58Z"), "Asia/Shanghai"), "1231 23:59:58");
  assert.equal(copyTimestamp(Number.NaN, "Asia/Shanghai"), "");
});

test("copy lines merge the same style and size across orders and keep styles together", () => {
  const lines = aggregateCopyLines([
    { items: [
      { sku: "DD1391", title: "黑钻5", size: "XL", qty: 2 },
      { sku: "SUN-P", title: "小太阳粉", size: "M", qty: 1 },
    ] },
    { items: [
      { sku: "SUN-P", title: "小太阳粉", size: "L", qty: 3 },
      { sku: "DD1391", title: "黑钻5", size: "XL", qty: 1 },
      { sku: " SUN-P ", title: "小太阳粉 ", size: "M", qty: 2 },
      { sku: "", title: "", size: "M", qty: 5 },
      { sku: "X", title: "无效数量", size: "M", qty: 0 },
    ] },
  ]);
  assert.deepEqual(lines, [
    { sku: "DD1391", title: "黑钻5", size: "XL", qty: 3 },
    { sku: "SUN-P", title: "小太阳粉", size: "M", qty: 3 },
    { sku: "SUN-P", title: "小太阳粉", size: "L", qty: 3 },
  ]);
});

test("copy line skips empty fields and does not repeat a sku that equals the title", () => {
  assert.equal(formatCopyLine({ sku: "DD1391", title: "黑钻5", size: "XL", qty: 3 }), "DD1391 黑钻5 XL ×3");
  assert.equal(formatCopyLine({ sku: "A15BA45075", title: "A15BA45075", size: "L", qty: 6 }), "A15BA45075 L ×6");
  assert.equal(formatCopyLine({ sku: "", title: "火炉", size: "", qty: 1 }), "火炉 ×1");
});

test("order copy text matches the shared purchase-list layout", () => {
  const text = buildOrderCopyText([
    { items: [
      { sku: "DD1391", title: "黑钻5", size: "XL", qty: 3 },
      { sku: "SUN-P", title: "小太阳粉", size: "M", qty: 3 },
    ] },
    { items: [
      { sku: "SUN-P", title: "小太阳粉", size: "L", qty: 3 },
      { sku: "A15BA45075", title: "A15BA45075", size: "L", qty: 6 },
    ] },
  ], now, "Asia/Shanghai");
  assert.equal(text, [
    "0919 14:05:09",
    "",
    "货号 商品名 尺码规格 数量",
    "DD1391 黑钻5 XL ×3",
    "SUN-P 小太阳粉 M ×3",
    "SUN-P 小太阳粉 L ×3",
    "A15BA45075 L ×6",
    "",
    "合计：15件",
  ].join("\n"));
  assert.equal(buildOrderCopyText([], now, "Asia/Shanghai").endsWith("合计：0件"), true);
});
