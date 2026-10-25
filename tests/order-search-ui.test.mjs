import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as search from "../lib/order-search.ts";
import * as pagination from "../lib/order-pagination.ts";
import * as time from "../lib/time.ts";
import * as settlement from "../lib/order-settlement.ts";

const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, {compilerOptions: {jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(nodes)];
const text = node => node == null || typeof node === "boolean" ? "" : typeof node !== "object" ? String(node) : (node.props?.children ?? []).flat(Infinity).map(text).join("");
const makeOrder = (id, sku, extra = {}) => ({
    id, title: "测试商品", platform: "淘宝", platformNo: id, purchaser: "小林", createdAt: "2026-10-25T02:00:00Z",
    status: "在途", settled: false, amount: 10, itemCount: 1, images: [], settlementProofs: [],
    items: [{id: `${id}-item`, title: "测试商品", sku, size: "M", qty: 1, amount: 10, purchaseCourierCompany: "顺丰", purchaseCourierNo: "SF-123"}], ...extra
});
const condition = (value, field = "sku", id = "1") => ({id, field, value});

function fixture(role = "admin", orders = [], initial = {}) {
    const states = [];
    let hookIndex = 0;
    const React = {createElement: (type, props, ...children) => ({type, props: {...props, children}}),
        useState: initial => {
            const index = hookIndex++;
            if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
            return [states[index], next => {states[index] = typeof next === "function" ? next(states[index]) : next;}];
        }, useMemo: compute => compute()};
    const modules = {react: React, "@/lib/order-search": search, "@/lib/order-pagination": pagination, "@/lib/time": time,
        "@/lib/order-settlement": settlement, "./server-clock": {useServerClock: () => ({now: Date.parse("2026-10-25T04:00:00Z"), timeZone: "Asia/Shanghai"})}};
    const exports = {};
    new Function("require", "exports", "React", `${code}; exports.components = {OrderSearch, AdminOrders, BuyerOrders, initialAdminOrderListState, initialBuyerOrderListState};`)(id => modules[id] ?? {}, exports, React);
    const components = exports.components;
    let viewState = {...(role === "admin" ? components.initialAdminOrderListState : components.initialBuyerOrderListState), ...initial};
    const setViewState = next => {viewState = typeof next === "function" ? next(viewState) : next;};
    const render = () => {
        hookIndex = 0;
        const tree = components[role === "admin" ? "AdminOrders" : "BuyerOrders"]({orders, viewState, setViewState});
        const all = nodes(tree);
        const searchNode = all.find(node => node.type === components.OrderSearch);
        const builder = components.OrderSearch(searchNode.props);
        const controls = nodes(builder);
        return {tree, all, builder, controls,
            cards: all.filter(node => ["OrderCard", "BuyerOrderCard"].includes(node.type?.name)),
            search: searchNode,
            button: label => [...all, ...controls].find(node => node.type === "button" && text(node).includes(label)),
            control: label => controls.find(node => node.props["aria-label"] === label),
            keyword: controls.find(node => node.type?.name === "Search")};
    };
    return {render, get state() {return viewState;}, remount: () => {states.length = 0;}};
}

test("both roles can add, edit and remove stable search rows and clear their search", () => {
    for (const role of ["admin", "buyer"]) {
        const f = fixture(role);
        f.render().keyword.props.onChange("订单");
        f.render().button("添加搜索条件").props.onClick();
        f.render().control("搜索条件 1 的字段").props.onChange({target: {value: "sku"}});
        f.render().control("搜索条件 1 的关键词").props.onChange({target: {value: "ABC"}});
        f.render().button("添加搜索条件").props.onClick();
        f.render().control("搜索条件 2 的关键词").props.onChange({target: {value: "DEF"}});
        const keptId = f.state.searchConditions[1].id;
        f.render().control("删除搜索条件 1").props.onClick();
        assert.deepEqual(f.state.searchConditions, [{id: keptId, field: "all", value: "DEF"}]);
        f.render().button("添加搜索条件").props.onClick();
        assert.equal(new Set(f.state.searchConditions.map(row => row.id)).size, 2);
        f.render().control("搜索条件关系").props.onChange({target: {value: "or"}});
        f.remount();
        assert.equal(f.render().keyword.props.value, "订单");
        assert.equal(f.render().control("搜索条件关系").props.value, "or");
        assert.equal(f.render().control("搜索条件 1 的关键词").props.value, "DEF");
        f.render().button("清空搜索").props.onClick();
        assert.equal(f.state.query, "");
        assert.deepEqual(f.state.searchConditions, []);
        assert.equal(f.state.searchMode, "and");
    }
});

test("actual lists combine keyword and row conditions while retaining platform, status and settlement filters", () => {
    const orders = [makeOrder("one", "ABC"), makeOrder("two", "DEF"), makeOrder("three", "ABC", {settled: true}),
        makeOrder("four", "ABC", {platform: "京东"}), makeOrder("five", "ABC", {status: "已驳回"}),
        makeOrder("six", "ABC", {createdAt: "2020-01-01T00:00:00Z"}), makeOrder("seven", "ABC", {purchaser: "其他采购员"})];
    for (const role of ["admin", "buyer"]) {
        const f = fixture(role, orders, {query: "one", searchConditions: [condition("DEF")], platform: "淘宝", statuses: ["在途"], settlement: "未结款", buyers: ["小林"]});
        assert.equal(f.render().cards.length, 0);
        f.render().control("搜索条件关系").props.onChange({target: {value: "or"}});
        assert.deepEqual(f.render().cards.map(node => node.props.order.id), ["one", "two"]);
        f.render().control("搜索条件 1 的关键词").props.onChange({target: {value: "ABC"}});
        assert.deepEqual(f.render().cards.map(node => node.props.order.id), role === "admin" ? ["one"] : ["one", "six", "seven"]);
    }
});

test("both roles can select XOR, exclude overlapping matches and retain it after returning to the list", () => {
    const orders = [makeOrder("one", "ABC"), makeOrder("two", "DEF"), makeOrder("three", "ABC", {platform: "京东"})];
    for (const role of ["admin", "buyer"]) {
        const f = fixture(role, orders, {query: "one", searchConditions: [condition("ABC")], platform: "淘宝"});
        const option = nodes(f.render().control("搜索条件关系")).find(node => node.type === "option" && node.props.value === "xor");
        assert.equal(text(option), "互斥（仅满足一项）");
        assert.deepEqual(f.render().cards.map(node => node.props.order.id), ["one"]);
        f.render().control("搜索条件关系").props.onChange({target: {value: "xor"}});
        assert.equal(f.render().cards.length, 0, "the order matching both conditions is excluded");
        f.render().control("搜索条件 1 的关键词").props.onChange({target: {value: "DEF"}});
        assert.deepEqual(f.render().cards.map(node => node.props.order.id), ["one", "two"]);
        assert.match(text(f.render().builder), /2 个有效条件 · 互斥/);
        assert.match(text(f.render().builder), /仅满足一个有效搜索条件/);
        f.remount();
        assert.equal(f.render().control("搜索条件关系").props.value, "xor");
        assert.deepEqual(f.render().cards.map(node => node.props.order.id), ["one", "two"]);
        f.render().button("添加搜索条件").props.onClick();
        assert.deepEqual(f.render().cards.map(node => node.props.order.id), ["one", "two"], "blank row is ignored");
        f.render().button("清空搜索").props.onClick();
        assert.equal(f.state.searchMode, "and");
    }
});

test("changing any search control resets page and admin selection, even when the same order still matches", () => {
    const orders = Array.from({length: 60}, (_, index) => makeOrder(`order-${index}`, "ABC"));
    for (const role of ["admin", "buyer"]) {
        for (const change of [
            view => view.keyword.props.onChange("ABC"),
            view => view.button("添加搜索条件").props.onClick(),
            view => view.control("搜索条件 1 的关键词").props.onChange({target: {value: "ABC"}}),
            view => view.control("搜索条件 1 的字段").props.onChange({target: {value: "all"}}),
            view => view.control("搜索条件关系").props.onChange({target: {value: "or"}}),
            view => view.control("搜索条件关系").props.onChange({target: {value: "xor"}}),
            view => view.control("删除搜索条件 1").props.onClick(),
            view => view.button("清空搜索").props.onClick()
        ]) {
            const f = fixture(role, orders, {page: 2, searchConditions: [condition("")]});
            if (role === "admin") f.render().cards[0].props.onSelect();
            change(f.render());
            assert.equal(f.state.page, 1);
            assert.equal(f.render().cards[0].props.order.id, "order-0");
            if (role === "admin") {
                f.render().all.find(node => node.type?.name === "OrderPagination").props.onPageChange(2);
                assert.ok(f.render().cards.every(node => !node.props.selected));
            }
        }
    }
});

test("admin clear-all and shipping guide reset condition rows, mode and keyword", () => {
    for (const label of ["清除全部筛选", "笔订单等待更新发货信息"]) {
        const f = fixture("admin", [makeOrder("ready", "ABC", {status: "待发货"})], {query: "missing", searchConditions: [condition("missing")], searchMode: "or"});
        f.render().button(label).props.onClick();
        assert.equal(f.state.query, "");
        assert.deepEqual(f.state.searchConditions, []);
        assert.equal(f.state.searchMode, "and");
        assert.equal(f.render().cards.length, 1);
    }
    const f = fixture("admin", [], {searchConditions: [condition("")]});
    assert.equal(f.render().button("清除全部筛选").props.disabled, false);
});

test("buyer condition field choices exclude administrator data", () => {
    for (const role of ["admin", "buyer"]) {
        const f = fixture(role, [], {searchConditions: [condition("")]});
        const options = nodes(f.render().control("搜索条件 1 的字段")).filter(node => node.type === "option").map(node => node.props.value);
        assert.equal(options.includes("outboundCourier"), role === "admin");
        assert.equal(options.includes("purchaser"), role === "admin");
        assert.ok(options.includes("sku"));
    }
});
