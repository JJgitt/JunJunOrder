import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import ts from "typescript";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const compile = source => ts.transpileModule(source, {compilerOptions: {jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022}}).outputText;
function sourceBetween(start, end) {
    const first = page.indexOf(start), last = page.indexOf(end, first);
    assert.ok(first >= 0 && last > first);
    return page.slice(first, last);
}
const uploadCode = compile(`${sourceBetween("const courierCompanies =", "async function copyText(")}\n${sourceBetween("function UploadPage(", "function BuyerOrders(")}`);
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(nodes)];
const text = node => node == null || typeof node === "boolean" ? "" : typeof node !== "object" ? String(node) : (node.props?.children ?? []).flat(Infinity).map(text).join("");
const order = {
    id: "note-order", platform: "淘宝", platformNo: "note-platform", purchaser: "采购人", purchaserId: "buyer", status: "在途",
    adminNote: "原备注\n第二行", courierCompany: "顺丰速运", courierNo: "SF-note", createdAt: "2026-10-28T04:00:00Z",
    items: [{id: "note-item", title: "商品", sku: "SKU", size: "M", qty: 2, amount: 100, purchaseCourierCompany: "顺丰速运", purchaseCourierNo: "SF-note"}],
    title: "商品", itemCount: 1, amount: 100, settled: false, images: [], settlementProofs: [],
};
function fixture({mode = "admin", editing = order, onSubmit = async () => {}} = {}) {
    const states = [], calls = []; let index = 0;
    const fakeReact = {createElement: (type, props, ...children) => ({type, props: {...props, children}})};
    const useState = initial => {
        const key = index++;
        if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial;
        return [states[key], value => {states[key] = typeof value === "function" ? value(states[key]) : value;}];
    };
    const Upload = new Function("React", "useState", "money", "UploadTutorialLink", `${uploadCode}; return UploadPage;`)(fakeReact, useState, value => `¥${value.toFixed(2)}`, "UploadTutorialLink");
    const render = () => {
        index = 0;
        const tree = Upload({mode, editing, currentUserId: "admin", onSubmit: async (...args) => {calls.push(args); await onSubmit(...args);}});
        const all = nodes(tree);
        return {tree, all, form: all.find(node => node.type === "form"), note: all.find(node => node.props["aria-label"] === "管理员备注"),
            save: all.find(node => node.type === "button" && node.props.className === "primary-button"),
            field: label => nodes(all.find(node => node.type === "label" && text(node).startsWith(label))).find(node => node.type === "input")};
    };
    const changeNote = value => render().note.props.onChange({target: {value}});
    const submit = () => render().form.props.onSubmit({preventDefault() {}});
    return {render, changeNote, submit, calls};
}

test("administrator edit preloads a multiline optional note, updates its counter and sends explicit clearing", async () => {
    const f = fixture();
    assert.equal(f.render().note.props.value, order.adminNote);
    assert.equal(f.render().note.props.maxLength, 1000);
    assert.equal(f.render().note.props.rows, 4);
    assert.match(text(f.render().tree), /仅管理员可见/);
    f.changeNote("新备注\n第二行");
    assert.match(text(f.render().tree), /7\/1000/);
    await f.submit();
    assert.equal(f.calls[0][0].adminNote, "新备注\n第二行");
    f.changeNote(""); await f.submit();
    assert.equal(f.calls[1][0].adminNote, "", "clearing must send an empty string rather than omit the field");
});

test("save failure retains the administrator's draft and unlocking the form allows retry", async () => {
    let reject;
    const pending = new Promise((_resolve, fail) => {reject = fail;});
    const f = fixture({onSubmit: () => pending});
    f.changeNote("待重试备注");
    const failed = assert.rejects(f.submit(), /保存失败/);
    assert.equal(f.render().note.props.disabled, true);
    assert.equal(f.render().save.props.disabled, true);
    reject(new Error("保存失败")); await failed;
    assert.equal(f.render().note.props.value, "待重试备注");
    assert.equal(f.render().note.props.disabled, false);
    assert.equal(f.render().save.props.disabled, false);
});

test("buyer edits cannot show or send internal notes, and new administrator entry has no note editor", async () => {
    const buyer = fixture({mode: "buyer"});
    assert.equal(buyer.render().note, undefined);
    await buyer.submit(); assert.equal("adminNote" in buyer.calls[0][0], false);
    const fresh = fixture({editing: null});
    assert.equal(fresh.render().note, undefined);
    for (const [label, value] of [["商品名称 *", "商品"], ["货号 *", "SKU"], ["尺码 *", "M"], ["实付金额 *", "100"], ["采购快递单号 *", "SF-new"]]) fresh.render().field(label).props.onChange({target: {value}});
    await fresh.submit(); assert.equal("adminNote" in fresh.calls[0][0], false);
});

const ignored = () => null;
const detailStubs = {
    React, useServerClock: () => ({dateTime: value => value ?? ""}),
    // eslint-disable-next-line react/prop-types -- Test wrapper bypasses the portal without replacing the actual detail body.
    Modal: ({children}) => React.createElement("section", null, children),
    KeyValue: ignored, CopyNumber: ignored, CopyButton: ignored, Badge: ignored,
    PurchaseCourierList: ignored, TrackingPanel: ignored, OrderImages: ignored,
    postReceiptTimelineEvents: () => [], timestamp: () => 0, canSettleOrder: () => false, isSettlementStage: () => true,
};
const detailCode = compile(`${sourceBetween("const statusTone:", "const initialAdminOrderListState:")}\n${sourceBetween("function OrderDetail(", "function OrderImageUploadSheet(")}`);
const Detail = new Function(...Object.keys(detailStubs), `${detailCode}; return OrderDetail;`)(...Object.values(detailStubs));
test("detail renders escaped multiline note text only for an administrator, and hides an empty note", () => {
    const value = "私密说明\n<script>alert('x')</script> & 再核对";
    const render = (canManage, adminNote = value) => renderToStaticMarkup(React.createElement(Detail, {order: {...order, adminNote}, canManage, showLocation: canManage}));
    const admin = render(true);
    assert.match(admin, /aria-label="管理员备注"/);
    assert.match(admin, /私密说明\n&lt;script&gt;/);
    assert.match(admin, /&amp; 再核对/);
    assert.doesNotMatch(admin, /<script>/);
    assert.doesNotMatch(render(false), /管理员备注|私密说明|再核对/);
    assert.doesNotMatch(render(true, ""), /aria-label="管理员备注"/);
});
