import assert from "node:assert/strict";
import test from "node:test";
import {ORDER_PAGE_SIZE, paginateOrders} from "../lib/order-pagination.ts";

test("up to 50 filtered orders retain the existing unpaginated list", () => {
    assert.equal(ORDER_PAGE_SIZE, 50);
    const orders = Array.from({length: 50}, (_, index) => index + 1);
    for (const count of [0, 49, 50]) {
        const result = paginateOrders(orders.slice(0, count), 1);
        assert.equal(result.paginated, false);
        assert.equal(result.pageCount, 1);
        assert.deepEqual(result.items, orders.slice(0, count));
    }
});

test("the 51st order starts page two, and 501 orders occupy eleven pages", () => {
    const orders = Array.from({length: 501}, (_, index) => index + 1);
    const first = paginateOrders(orders.slice(0, 51), 1);
    assert.equal(first.paginated, true);
    assert.equal(first.pageCount, 2);
    assert.deepEqual(first.items, orders.slice(0, 50));
    const second = paginateOrders(orders.slice(0, 51), 2);
    assert.deepEqual(second.items, [51]);
    assert.deepEqual([second.start, second.end], [51, 51]);
    const last = paginateOrders(orders, 11);
    assert.equal(last.pageCount, 11);
    assert.deepEqual(last.items, [501]);
    assert.deepEqual([last.start, last.end], [501, 501]);
});

test("stale page numbers clamp when a refreshed result shrinks", () => {
    const orders = [1, 2, 3];
    assert.equal(paginateOrders(orders, 11).page, 1);
    assert.equal(paginateOrders(orders, 0).page, 1);
    assert.equal(paginateOrders(orders, Number.NaN).page, 1);
    assert.deepEqual(paginateOrders(orders, 11).items, orders);
});

test("filter and sort the complete result before applying the 50-order page", () => {
    const orders = Array.from({length: 501}, (_, index) => index + 1);
    const matches = orders.filter(value => value % 2 === 0).sort((a, b) => b - a);
    const first = paginateOrders(matches, 1);
    const second = paginateOrders(matches, 2);
    assert.equal(first.total, 250);
    assert.equal(first.pageCount, 5);
    assert.deepEqual(first.items, matches.slice(0, 50));
    assert.deepEqual(second.items, matches.slice(50, 100));
    assert.equal(second.items[0], 400);
});
