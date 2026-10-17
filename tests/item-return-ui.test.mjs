import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const source = page.slice(page.indexOf("function ReturnItemSheet("), page.indexOf("function RollbackShipmentSheet("));
const code = ts.transpileModule(source, {compilerOptions: {jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022}}).outputText;
const React = {createElement: (type, props, ...children) => ({type, props: {...props, children}})};
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(nodes)];
const text = node => node == null || typeof node === "boolean" ? "" : typeof node !== "object" ? String(node) : (node.props?.children ?? []).flat(Infinity).map(text).join("");
const item = {id: "item", title: "商品", sku: "SKU", size: "M", qty: 3, returnedQty: 1, amount: 10};
const order = {id: "order", platform: "淘宝", purchaser: "原采购人"};
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(onSubmit = async () => {}) {
    const states = [], refs = [], calls = [];
    let stateIndex = 0, refIndex = 0, closed = 0;
    const useState = initial => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = initial;
        return [states[index], value => {states[index] = value;}];
    };
    const useRef = initial => refs[refIndex] ?? (refs[refIndex++] = {current: initial});
    const Sheet = new Function("React", "useState", "useRef", "Modal", "CopyNumber", "money", "courierCompanies", `${code}; return ReturnItemSheet;`)(React, useState, useRef, "Modal", "CopyNumber", value => `¥${value.toFixed(2)}`, ["顺丰速运", "京东物流"]);
    const render = () => {
        stateIndex = refIndex = 0;
        const tree = Sheet({order, item, onClose: () => closed++, onSubmit: async payload => {calls.push(payload); await onSubmit(payload);}});
        const all = nodes(tree), field = label => nodes(all.find(node => node.type === "label" && text(node).includes(label))).find(node => node.type === "input" || node.type === "select");
        return {tree, all, field, form: all.find(node => node.type === "form"), save: all.find(node => node.props.type === "submit"),
            error: all.find(node => node.props.role === "alert"), cancel: all.find(node => node.type === "button" && text(node) === "取消")};
    };
    const fill = (label, value) => render().field(label).props.onChange({target: {value}});
    const valid = () => {fill("新订单号", " new-order "); fill("回流快递公司", "其他"); fill("其他快递公司名称", " 自填物流 "); fill("回流快递单号", " new-courier ");};
    const submit = view => view.form.props.onSubmit({preventDefault() {}});
    return {render, fill, valid, submit, calls, get closed() {return closed;}};
}
test("return form requires manually supplied numbers/company, preserves deletable quantity drafts and previews exact fractional cents", async () => {
    const f = fixture();
    assert.equal(f.render().save.props.disabled, true);
    assert.equal(f.render().field("新订单号").props.value, "");
    assert.equal(f.render().field("回流快递单号").props.value, "");
    assert.match(text(f.render().tree), /¥3.34/);
    f.valid(); f.fill("回流件数", "");
    assert.equal(f.render().field("回流件数").props.value, "");
    f.submit(f.render()); assert.equal(f.calls.length, 0);
    assert.match(text(f.render().error), /1～2/);
    for (const qty of ["0", "-1", "1.5", "3"]) {f.fill("回流件数", qty); f.submit(f.render()); assert.equal(f.calls.length, 0);}
    f.fill("回流件数", "2"); assert.match(text(f.render().tree), /¥6.67/);
    f.submit(f.render()); await tick();
    assert.deepEqual(f.calls, [{orderId: "order", itemId: "item", qty: 2, platformNo: "new-order", company: "自填物流", courier: "new-courier"}]);
});
test("rapid double submission and closing during creation are blocked; server failures retain all entered fields", async () => {
    let fail;
    const pending = new Promise((_resolve, reject) => {fail = reject;});
    const f = fixture(() => pending); f.valid();
    const stale = f.render(); f.submit(stale); f.submit(stale);
    assert.equal(f.calls.length, 1);
    const busy = f.render();
    assert.equal(busy.tree.props.closeDisabled, true);
    assert.equal(busy.save.props.disabled, true);
    assert.equal(busy.all.find(node => node.type === "fieldset").props.disabled, true);
    busy.tree.props.onClose(); stale.cancel.props.onClick(); assert.equal(f.closed, 0);
    fail(new Error("该采购渠道下的订单号已存在")); await tick();
    assert.match(text(f.render().error), /订单号已存在/);
    assert.equal(f.render().field("新订单号").props.value, " new-order ");
    assert.equal(f.render().field("回流快递单号").props.value, " new-courier ");
    assert.equal(f.render().save.props.disabled, false);
    f.render().cancel.props.onClick(); assert.equal(f.closed, 1);
});
