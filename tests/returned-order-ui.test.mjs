import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import ts from "typescript";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/workspace-ui.css", import.meta.url), "utf8");
function sourceBetween(start, end) {
    const first = page.indexOf(start), last = page.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Expected source boundaries ${start}, ${end}`);
    return page.slice(first, last);
}
const source = [
    sourceBetween("const statusTone:", "const initialAdminOrderListState:"),
    sourceBetween("function Badge(", "function CopyButton("),
    sourceBetween("function OrderCard(", "function SettlementStatus("),
    sourceBetween("function BuyerOrderCard(", "function UploadTutorialLink("),
    sourceBetween("function OrderDetail(", "function OrderImageUploadSheet("),
].join("\n");
const compiled = ts.transpileModule(source, {
    compilerOptions: {jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const ignored = () => null;
const stubs = {
    React,
    useServerClock: () => ({dateTime: value => value ?? ""}),
    // eslint-disable-next-line react/prop-types -- Test-only wrapper isolates the real detail body from portal/browser APIs.
    Modal: ({children}) => React.createElement("section", null, children),
    CopyNumber: ignored, CopyButton: ignored, KeyValue: ignored, PurchaseCourierList: ignored,
    TrackingPanel: ignored, OrderImages: ignored, SettlementStatus: ignored, OutboundOrderInfo: ignored,
    postReceiptTimelineEvents: () => [], timestamp: () => 0,
    canSettleOrder: () => false, isSettlementStage: () => true,
};
const {OrderCard, BuyerOrderCard, OrderDetail} = new Function(...Object.keys(stubs),
    `${compiled}; return {OrderCard, BuyerOrderCard, OrderDetail};`)(...Object.values(stubs));
const order = {
    id: "test-order", platform: "淘宝", platformNo: "test-platform", purchaser: "采购员",
    createdAt: "2026-10-16T04:00:00Z", title: "测试商品", itemCount: 1, amount: 80,
    status: "在途", settled: false, images: [], settlementProofs: [],
    items: [{id: "test-item", title: "测试商品", sku: "TEST-01", size: "M", qty: 2, amount: 80}],
};
const renderCard = (values, props = {}) => renderToStaticMarkup(React.createElement(OrderCard,
    {order: {...order, ...values}, onOpen() {}, ...props}));
const renderDetail = (values, canManage) => renderToStaticMarkup(React.createElement(OrderDetail,
    {order: {...order, ...values}, canManage, showLocation: canManage, onClose() {}}));
const statuses = ["待审核", "在途", "已入库", "待发货", "已发货", "已驳回"];
const displayedStatus = status => status === "已入库" ? "待发货" : status;

test("admin cards retain the return flag after subsequent receipt and shipping without replacing current status", () => {
    for (const status of statuses) {
        const html = renderCard({status, isReturned: true}, {showReturnFlag: true});
        assert.match(html, /class="order-returned-badge"[^>]*>回流<\/span>/, status);
        assert.ok(html.includes(`>${displayedStatus(status)}</span>`), `current status retained: ${status}`);
        assert.match(html, /测试商品 · M码等2件/, "product title and total quantity are unchanged");
        assert.equal((html.match(/>回流<\/span>/g) ?? []).length, 1);
    }
});

test("ordinary cards and legacy snapshots without a return flag do not acquire the mark", () => {
    for (const isReturned of [undefined, false]) {
        assert.doesNotMatch(renderCard({isReturned}, {showReturnFlag: true}), /order-returned-badge|>回流</);
        assert.doesNotMatch(renderDetail({isReturned}, true), /order-returned-badge|>回流</);
    }
    assert.doesNotMatch(renderCard({isReturned: true}), /order-returned-badge|>回流</,
        "the shared card defaults to withholding the admin-only marker");
});

test("only administrator details show the return mark beside all existing statuses", () => {
    for (const status of statuses) {
        const admin = renderDetail({status, isReturned: true}, true);
        assert.match(admin, /class="order-returned-badge"[^>]*>回流<\/span>/, status);
        assert.ok(admin.includes(`>${displayedStatus(status)}</span>`));
        const buyer = renderDetail({status, isReturned: true}, false);
        assert.doesNotMatch(buyer, /order-returned-badge|>回流</, status);
        assert.ok(buyer.includes(`>${status}</span>`), "buyer status is not normalized or replaced");
    }
});

test("actual buyer card wrapper hides the admin mark even if a fixture includes the private field", () => {
    for (const status of ["在途", "已入库"]) {
        const html = renderToStaticMarkup(React.createElement(BuyerOrderCard, {
            order: {...order, status, isReturned: true}, onOpen() {}, onEdit() {},
        }));
        assert.doesNotMatch(html, /order-returned-badge|>回流</);
        assert.ok(html.includes(`>${status}</span>`));
        assert.match(html, /测试商品 · M码等2件/);
    }
});

test("same SKU return counts sum quantities across item rows, and buyer views expose neither counts nor links", () => {
    const items = [
        {...order.items[0], id: "first", qty: 3, returnedQty: 2, shipped: true, returnOrders: [{orderId: "child", platformNo: "child-no", qty: 2}]},
        {...order.items[0], id: "second", qty: 2, returnedQty: 2, shipped: true},
    ];
    const values = {status: "已发货", items, itemCount: 2};
    const card = renderCard(values, {showReturnFlag: true});
    assert.match(card, /回流 ×4/);
    assert.equal((card.match(/回流 ×/g) ?? []).length, 1);
    const detail = renderDetail(values, true);
    assert.match(detail, /部分已回流/); assert.match(detail, /已回流 · 货号/); assert.match(detail, /查看新单/);
    assert.equal((detail.match(/商品回流建单/g) ?? []).length, 1, "only the item with remaining quantity is actionable");
    assert.doesNotMatch(detail, /回滚到在途（未结款）/, "partial returns disable whole-order rollback");
    assert.doesNotMatch(renderCard(values), /回流 ×/);
    assert.doesNotMatch(renderDetail(values, false), /回流|查看新单/);
    assert.doesNotMatch(renderDetail({...values, status: "待发货"}, true), /商品回流建单/);
});

test("only admins can navigate from a return child to the source order and its original images", () => {
    const values = {returnSourceOrderId: "source", returnQuantity: 2};
    assert.match(renderDetail(values, true), /查看原订单与图片/);
    assert.match(renderDetail(values, true), /不重复计入看板采购额/);
    assert.doesNotMatch(renderDetail(values, false), /回流来源|查看原订单/);
});

test("administrator list explicitly opts in without changing the shared card's safe default", () => {
    const ast = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const admin = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "AdminOrders");
    assert.ok(admin);
    const cards = [];
    function visit(node) {
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "OrderCard") cards.push(node);
        ts.forEachChild(node, visit);
    }
    visit(admin);
    assert.ok(cards.length > 0);
    for (const card of cards) {
        const attr = card.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.text === "showReturnFlag");
        assert.ok(attr && !attr.initializer, "admin list must pass the true boolean prop explicitly");
    }
});

test("return labels are readable and can wrap without changing touch-form safeguards", () => {
    assert.match(css, /\.order-state-labels\s*\{[^}]*flex-wrap: wrap;[^}]*max-width: 100%/);
    assert.match(css, /\.order-top\s*\{[^}]*flex-wrap: wrap/);
    assert.match(css, /\.detail-title\s*\{[^}]*flex-wrap: wrap/);
    const rule = css.match(/\.order-returned-badge\s*\{([^}]+)\}/)?.[1];
    assert.ok(rule);
    assert.match(rule, /background: #f1ebff/);
    assert.match(rule, /color: #65409b/);
    assert.match(rule, /font-weight: 700/);
    const luminance = hex => {
        const [r, g, b] = hex.match(/../g).map(channel => {
            const value = parseInt(channel, 16) / 255;
            return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
        });
        return .2126 * r + .7152 * g + .0722 * b;
    };
    assert.ok((luminance("f1ebff") + .05) / (luminance("65409b") + .05) >= 4.5);
});
