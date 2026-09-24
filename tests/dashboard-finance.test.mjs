import assert from "node:assert/strict";
import test from "node:test";
import {financeMonthOptions, monthlyFinance} from "../lib/dashboard-finance.ts";
import {dateKey, timestamp} from "../lib/time.ts";

const calendar = {dateKey, timestamp};
const item = (amount, salePrice, shippedAt, qty = 1) => ({amount, salePrice, shippedAt, qty});
const order = (createdAt, status, amount, items = []) => ({createdAt, status, amount, items});

test("monthly finance uses the server calendar month across midnight and year boundaries", () => {
    const orders = [
        order("2026-12-31T15:59:59Z", "已入库", 20, [item(20, 30, "2026-12-31T15:59:59Z")]),
        order("2026-12-31T16:00:00Z", "已入库", 100, [item(100, 150, "2026-12-31T16:01:00Z")]),
        order("2026-12-31T16:11:00Z", "已入库", 200, [item(200, 250, "2026-12-31T16:11:00Z")]),
        order("2026-12-31T16:02:00Z", "已驳回", 300, []),
    ];
    const now = Date.parse("2026-12-31T16:10:00Z");
    assert.deepEqual(monthlyFinance(orders, now, "Asia/Shanghai", calendar), {
        month: "2027-01", purchase: 100, sales: 150, profit: 50, unpricedShippedQuantity: 0,
    });
    assert.deepEqual(monthlyFinance(orders, now, "UTC", calendar), {
        month: "2026-12", purchase: 120, sales: 180, profit: 60, unpricedShippedQuantity: 0,
    });
    assert.deepEqual(monthlyFinance(orders, now, "Asia/Shanghai", calendar, "2026-12"), {
        month: "2026-12", purchase: 20, sales: 30, profit: 10, unpricedShippedQuantity: 0,
    });
});

test("sales and estimated profit use each item's shipment month, not the order month or settlement state", () => {
    const orders = [
        order("2026-09-20T10:00:00+08:00", "已入库", 500, [
            item(200, 260, "2026-09-30T23:59:59+08:00"),
            item(300, 380, "2026-10-01T00:00:00+08:00", 2),
        ]),
        order("2026-10-02T10:00:00+08:00", "待发货", 70, [item(70, 120, undefined)]),
    ];
    assert.deepEqual(monthlyFinance(orders, Date.parse("2026-10-24T10:00:00+08:00"), "Asia/Shanghai", calendar), {
        month: "2026-10", purchase: 70, sales: 380, profit: 80, unpricedShippedQuantity: 0,
    });
    assert.deepEqual(monthlyFinance(orders, Date.parse("2026-10-24T10:00:00+08:00"), "Asia/Shanghai", calendar, "2026-09"), {
        month: "2026-09", purchase: 500, sales: 260, profit: 60, unpricedShippedQuantity: 0,
    });
});

test("an unpriced shipped item is counted separately; line totals are not multiplied by quantity", () => {
    const orders = [order("2026-10-02T10:00:00+08:00", "已发货", 315, [
        item(300, 420, "2026-10-03T10:00:00+08:00", 2),
        item(15, undefined, "2026-10-04T10:00:00+08:00", 3),
    ])];
    assert.deepEqual(monthlyFinance(orders, Date.parse("2026-10-24T10:00:00+08:00"), "Asia/Shanghai", calendar), {
        month: "2026-10", purchase: 315, sales: 420, profit: 120, unpricedShippedQuantity: 3,
    });
});

test("estimated profit may be negative and later price edits recalculate the current month's figures", () => {
    const shippedAt = "2026-10-04T10:00:00+08:00";
    const now = Date.parse("2026-10-24T10:00:00+08:00");
    const withPrice = salePrice => [order("2026-09-20T10:00:00+08:00", "已发货", 100.2, [item(100.2, salePrice, shippedAt, 2)])];
    assert.deepEqual(monthlyFinance(withPrice(90.1), now, "Asia/Shanghai", calendar), {
        month: "2026-10", purchase: 0, sales: 90.1, profit: -10.1, unpricedShippedQuantity: 0,
    });
    assert.deepEqual(monthlyFinance(withPrice(120.3), now, "Asia/Shanghai", calendar), {
        month: "2026-10", purchase: 0, sales: 120.3, profit: 20.1, unpricedShippedQuantity: 0,
    });
});

test("missing and future timestamps do not contribute to the current month", () => {
    const now = Date.parse("2026-10-24T10:00:00+08:00");
    const orders = [
        order("invalid", "在途", 10, [item(10, 20, "invalid")]),
        order("2026-10-25T10:00:00+08:00", "在途", 30, [item(30, 50, "2026-10-25T10:00:00+08:00")]),
        order("2026-10-23T10:00:00+08:00", "已入库", 0.1, [item(0.1)]),
        order("2026-10-23T10:00:00+08:00", "已入库", 0.2, [item(0.2)]),
    ];
    assert.deepEqual(monthlyFinance(orders, now, "Asia/Shanghai", calendar), {
        month: "2026-10", purchase: 0.3, sales: 0, profit: 0, unpricedShippedQuantity: 0,
    });
});

test("a historical month with no transactions shows zero and invalid or future selections fall back to the server month", () => {
    const now = Date.parse("2026-10-24T10:00:00+08:00");
    const orders = [order("2026-10-02T10:00:00+08:00", "已入库", 50)];
    assert.deepEqual(monthlyFinance(orders, now, "Asia/Shanghai", calendar, "2026-08"), {
        month: "2026-08", purchase: 0, sales: 0, profit: 0, unpricedShippedQuantity: 0,
    });
    for (const invalid of ["2026-11", "2026-13", "2026-1", "invalid"]) {
        assert.equal(monthlyFinance(orders, now, "Asia/Shanghai", calendar, invalid).month, "2026-10");
    }
});

test("month choices include a recent year, older order months, and a retained selected month", () => {
    const now = Date.parse("2026-09-24T10:00:00+08:00");
    const recent = financeMonthOptions([], now, "Asia/Shanghai", calendar);
    assert.equal(recent.length, 12);
    assert.equal(recent[0], "2026-09");
    assert.equal(recent.at(-1), "2025-10");

    const orders = [order("2024-12-15T10:00:00+08:00", "已发货", 20, [item(20, 30, "2025-01-05T10:00:00+08:00")])];
    const months = financeMonthOptions(orders, now, "Asia/Shanghai", calendar, "2024-11");
    assert.equal(months[0], "2026-09");
    assert.equal(months.at(-1), "2024-11");
    assert.ok(months.includes("2025-06"), "months without orders remain selectable");
    assert.equal(months.length, new Set(months).size);
});
