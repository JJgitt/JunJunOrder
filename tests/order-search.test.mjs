import assert from "node:assert/strict";
import test from "node:test";
import {initialOrderSearchState, matchesOrderSearch} from "../lib/order-search.ts";
import {paginateOrders} from "../lib/order-pagination.ts";

const order = {
    id: "INTERNAL-1", platformNo: "TB-100", title: "运动鞋", purchaser: "采购小林",
    courierCompany: "顺丰", courierNo: "SF-HEAD",
    items: [
        {title: "运动鞋", sku: "NK-001", size: "42", purchaseCourierCompany: "顺丰", purchaseCourierNo: "SF-100", outboundCompany: "京东", outboundCourier: "JD-200"},
        {title: "运动外套", sku: "JK-002", size: "XL", purchaseCourierCompany: "圆通", purchaseCourierNo: "YT-300"}
    ]
};
const search = (query, searchMode = "and", conditions = []) => ({query, searchMode,
    searchConditions: conditions.map(([field, value], index) => ({id: String(index + 1), field, value}))});

test("AND requires every nonempty condition; OR accepts any including the main query", () => {
    for (const role of ["admin", "buyer"]) {
        assert.equal(matchesOrderSearch(order, search("运动鞋", "and", [["sku", "nk-001"], ["size", "42"]]), role), true);
        assert.equal(matchesOrderSearch(order, search("运动鞋", "and", [["sku", "missing"]]), role), false);
        assert.equal(matchesOrderSearch(order, search("运动鞋", "or", [["sku", "missing"]]), role), true);
        assert.equal(matchesOrderSearch(order, search("missing", "or", [["sku", "NK-001"]]), role), true);
        assert.equal(matchesOrderSearch(order, search("missing", "or", [["sku", "other"]]), role), false);
    }
});

test("exclusive mode hides any matching condition, including a single condition and the main query", () => {
    for (const role of ["admin", "buyer"]) {
        assert.equal(matchesOrderSearch(order, search("运动鞋", "xor", [["sku", "missing"]]), role), false);
        assert.equal(matchesOrderSearch(order, search("missing", "xor", [["sku", "NK-001"]]), role), false);
        assert.equal(matchesOrderSearch(order, search("missing", "xor", [["sku", "other"]]), role), true);
        assert.equal(matchesOrderSearch(order, search("运动鞋", "xor", [["sku", "NK-001"]]), role), false);
        assert.equal(matchesOrderSearch(order, search("运动鞋", "xor", [["sku", "NK-001"], ["size", "42"]]), role), false);
        assert.equal(matchesOrderSearch(order, search("missing", "xor", [["sku", "NK-001"], ["size", "wrong"]]), role), false);
        assert.equal(matchesOrderSearch(order, search("", "xor", [["title", "运动"]]), role), false, "matching any item excludes the whole order");
        assert.equal(matchesOrderSearch(order, search("", "xor", [["sku", "NK-001"], ["sku", "NK-001"]]), role), false, "duplicate exclusions do not bring an order back");
        assert.equal(matchesOrderSearch(order, search("运动鞋", "xor"), role), false);
        assert.equal(matchesOrderSearch(order, search("missing", "xor"), role), true);
    }
});

test("empty conditions are ignored in all modes, including an empty main query", () => {
    for (const mode of ["and", "or", "xor"]) {
        assert.equal(matchesOrderSearch(order, search(" \t", mode, [["sku", "\n"]]), "admin"), true);
        assert.equal(matchesOrderSearch(order, search("", mode, [["sku", "missing"], ["title", " "]]), "admin"), mode === "xor");
        assert.equal(matchesOrderSearch(order, search("missing", mode, [["sku", ""]]), "admin"), mode === "xor");
        assert.equal(matchesOrderSearch(order, search("", mode, [["sku", " NK-001 \t"]]), "admin"), mode !== "xor");
    }
    assert.equal(matchesOrderSearch(order, initialOrderSearchState, "buyer"), true);
});

test("field constraints, case folding, all item titles and head courier fallback work", () => {
    for (const [field, value] of [["orderNo", "internal-1"], ["orderNo", "tb-100"], ["title", "运动外套"],
        ["sku", "jk-002"], ["size", " xl "], ["purchaseCourier", "sf-head"], ["purchaseCourier", "yt-300"], ["purchaseCourier", "顺丰"]]) {
        assert.equal(matchesOrderSearch(order, search("", "and", [[field, value]]), "buyer"), true, `${field}: ${value}`);
        assert.equal(matchesOrderSearch(order, search(value), "buyer"), true);
    }
    assert.equal(matchesOrderSearch(order, search("", "and", [["sku", "TB-100"]]), "admin"), false);
    assert.equal(matchesOrderSearch(order, search("", "and", [["orderNo", "NK-001"]]), "admin"), false);
    assert.equal(matchesOrderSearch(order, search("运动鞋", "and", [["sku", "JK-002"]]), "admin"), true, "conditions apply to the whole order");
});

test("search does not join unrelated fields or interpret regex syntax", () => {
    for (const value of ["INTERNAL-1TB-100", "NK-00142", "SF-100JD-200", ".*", "%"]) {
        assert.equal(matchesOrderSearch(order, search(value), "admin"), false);
    }
    assert.equal(matchesOrderSearch({...order, platformNo: "TB.[100]"}, search(".[100]"), "admin"), true);
});

test("buyer search never uses administrator-only fields, even if handed an admin-shaped order", () => {
    for (const [field, value] of [["outboundCourier", "JD-200"], ["outboundCourier", "京东"], ["purchaser", "采购小林"]]) {
        assert.equal(matchesOrderSearch(order, search("", "and", [[field, value]]), "admin"), true);
        assert.equal(matchesOrderSearch(order, search(value), "admin"), true);
        assert.equal(matchesOrderSearch(order, search("", "and", [[field, value]]), "buyer"), false);
        assert.equal(matchesOrderSearch(order, search(value), "buyer"), false);
        assert.equal(matchesOrderSearch(order, search("", "xor", [[field, value]]), "admin"), false);
        assert.equal(matchesOrderSearch(order, search("", "xor", [[field, value]]), "buyer"), true, "hidden administrator fields cannot exclude a buyer's order");
    }
    assert.equal(matchesOrderSearch({...order, items: []}, search("missing"), "buyer"), false);
});

test("combined search filters the complete collection before pagination", () => {
    const orders = Array.from({length: 120}, (_, index) => ({...order, id: String(index), platformNo: index === 119 ? "LAST" : "OTHER"}));
    const filtered = orders.filter(item => matchesOrderSearch(item, search("LAST", "and", [["sku", "NK-001"]]), "admin"));
    const result = paginateOrders(filtered, 1);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, "119");
    const excluded = orders.filter(item => matchesOrderSearch(item, search("OTHER", "xor"), "admin"));
    assert.deepEqual(paginateOrders(excluded, 1).items.map(item => item.id), ["119"], "exclusions apply before pagination as well");
});
