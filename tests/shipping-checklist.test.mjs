import assert from "node:assert/strict";
import test from "node:test";
import {parseShippingChecklist, validateChecklistItems, checklistSummary} from "../lib/shipping-checklist.ts";
import {buildOrderCopyText} from "../lib/order-copy.ts";

const sample = `1101 17:14:06

货号 商品名 尺码规格 数量
34Y5白玉鎏金-印花;XS 维密明星同款水光绸缎面丝滑 XS ×2
10T1粉丝带-印花 维密明星同款粉丝带印花xxs XXS ×1

10T1粉丝带-印花 维密明星同款 粉丝带-印花 XS ×1 礼袋
4RHY粉白条纹 维多利亚的秘密舒绒粉 S ×2 礼袋
4RHY粉白条纹11273305 维多利亚的秘密舒绒粉 XXS ×2 礼袋
04P4天蓝星芒 维密单依纯同款宅度假系列暖... XXS ×1 礼袋
04P4天蓝星芒 维密单依纯同款宅度假系列暖... XS ×1 礼袋
11273302 维多利亚的秘密 明星... 10T1粉丝带-印花 XXS ×1 礼袋
粉白条纹 维密·轻舒绒睡衣套 M ×1 礼袋

合计：12件`;
test("user sample becomes nine editable lines and twelve pieces without merging aliases, sizes or gift notes", () => {
    const result = parseShippingChecklist(sample);
    assert.equal(result.items.length, 9); assert.equal(result.totalQty, 12); assert.equal(result.declaredTotal, 12);
    assert.equal(result.sourceTimeText, "1101 17:14:06"); assert.deepEqual(result.unparsedLines, []);
    assert.equal(result.items.filter(item => item.note === "礼袋").length, 7);
    assert.equal(result.items[0].sku, "34Y5白玉鎏金-印花;XS"); assert.equal(result.items[0].size, "XS");
    assert.equal(result.items[2].title, "维密明星同款 粉丝带-印花");
    assert.equal(result.items[7].title, "维多利亚的秘密 明星... 10T1粉丝带-印花");
    assert.equal(result.items.every(item => !item.completed), true);
    assert.match(result.warnings.join(" "), /货号可能夹带规格/); assert.match(result.warnings.join(" "), /省略/);
    assert.equal(validateChecklistItems(result.items).error, undefined);
});
test("the current exported text imports back with aggregated quantities and preserves collapsed identity fields", () => {
    const text = buildOrderCopyText([{items: [{sku: "AX123-SKU-X2", title: "中文 商品", size: "41.5", qty: 2},
        {sku: "CODE", title: "CODE", size: "L", qty: 3}]}], Date.parse("2026-11-01T09:14:06Z"), "Asia/Shanghai");
    const parsed = parseShippingChecklist(text);
    assert.equal(parsed.items[0].sku, "AX123-SKU-X2"); assert.equal(parsed.items[0].qty, 2);
    assert.equal(parsed.items[1].sku, "CODE"); assert.equal(parsed.items[1].title, "CODE");
    assert.equal(parsed.totalQty, 5); assert.equal(parsed.sourceTimeText, "1101 17:14:06");
    assert.match(parsed.warnings.join(" "), /货号与名称未分开/);
    assert.doesNotMatch(parsed.warnings.join(" "), /多个数量标记/, "numbers embedded in SKUs do not trigger quantity ambiguity");
});
test("size and quantity suffix parsing handles clothing/shoes, attached markers and keeps packaging notes separate", () => {
    const parsed = parseShippingChecklist("A 商品 XS×2 礼袋 x1\nB 商品 41.5 x3\nC 商品 M/L *4\nD 商品 2XL ＊1");
    assert.deepEqual(parsed.items.map(item => [item.size, item.qty, item.note]), [["XS", 2, "礼袋 x1"], ["41.5", 3, ""], ["M/L", 4, ""], ["2XL", 1, ""]]);
    assert.match(parsed.warnings.join(" "), /多个数量标记/);
});
test("unrecognized lines and invalid quantities are reported, totals never hide dropped content", () => {
    const parsed = parseShippingChecklist("A 商品 M ×0\nB 商品 L ×1.5\nC 商品AX2\nD 商品 S ×1\n补充：联系仓库\n合计：9件");
    assert.equal(parsed.items.length, 1); assert.equal(parsed.totalQty, 1); assert.equal(parsed.unparsedLines.length, 4);
    assert.match(parsed.warnings.join(" "), /未识别/); assert.match(parsed.warnings.join(" "), /合计 9 件.*1 件/);
    assert.equal(parseShippingChecklist("").items.length, 0);
    assert.match(parseShippingChecklist("x".repeat(50001)).warnings.join(" "), /50000/);
    const many = parseShippingChecklist(Array.from({length: 201}, (_, index) => `SKU${index} 商品 M ×1`).join("\n"));
    assert.equal(many.items.length, 200); assert.equal(many.unparsedLines.length, 1);
});
test("validation rejects malformed rows, duplicated ids, invalid quantities and types without coercion", () => {
    const row = {id: "one", sku: " A ", title: "商品", size: "M", qty: 2, note: " 礼袋 ", completed: false};
    assert.equal(validateChecklistItems([row]).items[0].sku, "A");
    for (const value of [null, [], [null], [row, row], [{...row, qty: "2"}], [{...row, qty: 0}], [{...row, qty: 1.5}],
        [{...row, qty: Infinity}], [{...row, qty: 100001}], [{...row, note: "x".repeat(501)}], [{...row, completed: "false"}], [{...row, sku: "", title: ""}]]) {
        assert.equal(typeof validateChecklistItems(value).error, "string");
    }
});
test("completion summaries count actual pieces rather than product row count", () => {
    const items = parseShippingChecklist(sample).items;
    items[0].completed = true; items[1].completed = true;
    const summary = checklistSummary({id: "batch", title: "批次", sourceText: sample, sourceTimeText: "1101 17:14:06", declaredTotal: 12, items, version: 1, createdAt: "now", updatedAt: "now"});
    assert.equal(summary.itemCount, 9); assert.equal(summary.completedCount, 2);
    assert.equal(summary.totalQty, 12); assert.equal(summary.completedQty, 3);
});
