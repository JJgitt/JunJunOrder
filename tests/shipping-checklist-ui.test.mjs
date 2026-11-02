import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import test from "node:test";
import ts from "typescript";
import * as checklist from "../lib/shipping-checklist.ts";
import {dateKey} from "../lib/time.ts";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../app/shipping-checklist-panel.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, {compilerOptions: {jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = node => node == null || typeof node === "boolean" ? "" : typeof node !== "object" ? String(node) : [node.props?.children].flat(Infinity).map(text).join("");
const line = (id = "item-one", extra = {}) => ({id, sku: "SKU-01", title: "测试商品", size: "XS", qty: 2, note: "礼袋", completed: false, ...extra});
const record = (id = "checklist-one", extra = {}) => ({id, title: "测试发货清单", sourceText: "1101 17:14:06\nSKU-01 测试商品 XS ×2 礼袋\n合计：2件", sourceTimeText: "1101 17:14:06", declaredTotal: 2,
    items: [line()], version: 1, createdAt: "2026-11-01T09:14:06.000Z", updatedAt: "2026-11-01T09:14:06.000Z", ...extra});
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

function deferred() {
    let resolve;
    const promise = new Promise(done => {resolve = done;});
    return {promise, resolve};
}
function fixture({records = [], fetchResult, cryptoValue = globalThis.crypto} = {}) {
    const states = [], refs = [], effects = [], requests = [], notices = [];
    let stateIndex = 0, refIndex = 0, effectIndex = 0, queuedEffects = [];
    let saved = [...records];
    const useState = initial => {
        const key = stateIndex++;
        if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial;
        return [states[key], value => {states[key] = typeof value === "function" ? value(states[key]) : value;}];
    };
    const useRef = initial => {
        const key = refIndex++;
        return refs[key] ?? (refs[key] = {current: initial});
    };
    const useEffect = (callback, dependencies) => {
        const key = effectIndex++, old = effects[key];
        if (!old || dependencies.some((value, index) => !Object.is(value, old.dependencies[index]))) queuedEffects.push(() => {
            old?.cleanup?.(); effects[key] = {dependencies, cleanup: callback()};
        });
    };
    const createElement = (type, props) => ({type, props});
    const fetch = async (url, options = {}) => {
        const request = {url: String(url), options}; requests.push(request);
        const result = fetchResult?.(request);
        if (result !== undefined) return result;
        if (options.method === "POST") {
            const body = JSON.parse(options.body), created = record("new-checklist", {...body, version: 1});
            saved = [created, ...saved];
            return Response.json({checklist: created}, {status: 201});
        }
        if (options.method === "PATCH") {
            const body = JSON.parse(options.body), old = saved.find(row => row.id === body.id);
            if (!old) return Response.json({error: "清单不存在"}, {status: 404});
            const updated = body.action === "set-completed"
                ? {...old, version: old.version + 1, items: old.items.map(item => item.id === body.itemId ? {...item, completed: body.completed} : item)}
                : {...old, title: body.title, items: body.items, version: old.version + 1};
            saved = saved.map(row => row.id === updated.id ? updated : row);
            return Response.json({checklist: updated});
        }
        const params = new URL(String(url), "http://localhost").searchParams;
        if (params.has("id")) return Response.json({checklist: saved.find(row => row.id === params.get("id"))});
        const page = Number(params.get("page") || 1), totalPages = Math.max(1, Math.ceil(saved.length / 10));
        return Response.json({checklists: saved.slice((page - 1) * 10, page * 10).map(checklist.checklistSummary), page, pageSize: 10, total: saved.length, totalPages});
    };
    const styles = new Proxy({}, {get: (_target, key) => String(key)});
    const modules = {
        react: {useState, useRef, useEffect, useId: () => "checklist-test", useMemo: callback => callback(), useCallback: callback => callback},
        "react/jsx-runtime": {jsx: createElement, jsxs: createElement},
        "@/lib/shipping-checklist": checklist, "@/lib/time": {dateKey},
        "./server-clock": {useServerClock: () => ({now: "2026-11-02T03:00:00Z", timeZone: "Asia/Shanghai", dateTime: value => value ?? ""})},
        "./shipping-checklist-panel.module.css": {__esModule: true, default: styles},
    };
    const exports = {};
    new Function("require", "exports", "fetch", "globalThis", code)(name => modules[name] ?? require(name), exports, fetch, {crypto: cryptoValue});
    const render = () => {
        stateIndex = refIndex = effectIndex = 0; queuedEffects = [];
        const tree = exports.default({onNotify: message => notices.push(message)}), all = nodes(tree);
        queuedEffects.forEach(run => run());
        return {tree, all,
            control: label => all.find(node => node.props?.["aria-label"] === label),
            button: label => all.find(node => node.type === "button" && text(node).includes(label)),
            alerts: all.filter(node => node.props?.role === "alert"),
        };
    };
    return {render, requests, notices,
        open: async () => {render().control("发货清单").props.onClick(); render(); await nextTurn(); return render();},
        unmount: () => effects.forEach(effect => effect.cleanup?.()),
    };
}

test("pasting the supplied dispatch text produces editable nine-item twelve-piece preview and persists its original", async () => {
    const f = fixture();
    assert.equal(f.requests.length, 0);
    await f.open();
    f.render().button("新建发货清单").props.onClick();
    f.render().control("发货文案").props.onChange({target: {value: sample}});
    f.render().button("识别为清单").props.onClick();
    const preview = f.render();
    assert.match(text(preview.tree), /9 项 · 12 件/);
    assert.equal(preview.control("第 1 项数量").props.value, 2);
    assert.equal(preview.control("第 3 项备注").props.value, "礼袋");
    assert.equal(preview.control("第 1 项货号").props.value, "34Y5白玉鎏金-印花;XS", "ambiguous SKU remains available for correction");
    assert.equal(preview.control("第 8 项商品名").props.value.includes("明星..."), true, "truncated titles are not invented");
    preview.control("第 1 项货号").props.onChange({target: {value: "34Y5白玉鎏金-印花"}});
    f.render().control("清单名称").props.onChange({target: {value: "十一月第一批"}});
    f.render().control("发货清单").props.onClick();
    f.render().control("发货清单").props.onClick();
    assert.equal(f.render().control("清单名称").props.value, "十一月第一批", "folding the panel keeps its draft");
    const form = f.render().all.find(node => node.type === "form");
    form.props.onSubmit({preventDefault() {}}); await nextTurn();
    const post = f.requests.find(request => request.options.method === "POST"), body = JSON.parse(post.options.body);
    assert.equal(body.title, "十一月第一批"); assert.equal(body.sourceText, sample);
    assert.equal(body.sourceTimeText, "1101 17:14:06"); assert.equal(body.declaredTotal, 12);
    assert.equal(body.items.length, 9); assert.equal(body.items.reduce((sum, item) => sum + item.qty, 0), 12);
    assert.equal(body.items.filter(item => item.note === "礼袋").length, 7);
    assert.equal(body.items[0].sku, "34Y5白玉鎏金-印花");
    assert.ok(f.render().control(`完成清单项 ${body.items[0].id}`));
    assert.ok(f.requests.every(request => request.url.startsWith("/api/shipping-checklists")), "independent checklists never call order or inventory mutations");
});

test("invalid input and mismatched totals require correction or review, while failed saves retain the edited draft", async () => {
    const pending = deferred();
    const f = fixture({fetchResult: request => request.options.method === "POST" ? pending.promise : undefined});
    await f.open();
    f.render().button("新建发货清单").props.onClick();
    f.render().control("发货文案").props.onChange({target: {value: "SKU 商品 XS ×2 礼袋\n这行需要人工补充\n合计：3件"}});
    f.render().button("识别为清单").props.onClick();
    let view = f.render();
    assert.match(text(view.tree), /这行需要人工补充/);
    assert.match(text(view.tree), /件数与原文不一致/);
    assert.equal(view.button("保存清单").props.disabled, true);
    view.control("第 1 项数量").props.onChange({target: {value: ""}});
    const review = () => f.render().all.find(node => node.type === "input" && node.props.type === "checkbox");
    review().props.onChange({target: {checked: true}});
    f.render().all.find(node => node.type === "form").props.onSubmit({preventDefault() {}});
    assert.equal(f.requests.filter(request => request.options.method === "POST").length, 0);
    assert.match(text(f.render().tree), /数量需为/);
    f.render().control("第 1 项数量").props.onChange({target: {value: "3"}});
    review().props.onChange({target: {checked: true}});
    f.render().control("第 1 项备注").props.onChange({target: {value: "礼袋，人工核对完成"}});
    review().props.onChange({target: {checked: true}});
    view = f.render(); const form = view.all.find(node => node.type === "form");
    form.props.onSubmit({preventDefault() {}}); form.props.onSubmit({preventDefault() {}});
    assert.equal(f.requests.filter(request => request.options.method === "POST").length, 1, "same-turn double clicks submit once");
    assert.equal(f.render().button("正在保存").props.disabled, true);
    pending.resolve(Response.json({error: "保存失败，请重试"}, {status: 503})); await nextTurn();
    assert.match(text(f.render().tree), /保存失败，请重试/);
    assert.equal(f.render().control("第 1 项数量").props.value, 3);
    assert.equal(f.render().control("第 1 项备注").props.value, "礼袋，人工核对完成");
    assert.equal(f.render().control("发货文案").props.value.includes("人工补充"), true);
});

test("completion is saved independently with a version and failed or conflicting writes retain the last saved state", async () => {
    let fail = false;
    const pending = deferred();
    const f = fixture({records: [record()], fetchResult: request => {
        if (request.options.method === "PATCH" && fail) return Response.json({error: "清单已被其他操作更新"}, {status: 409});
        if (request.options.method === "PATCH") return pending.promise;
    }});
    await f.open();
    f.render().control("打开清单 checklist-one").props.onClick(); await nextTurn();
    const toggle = f.render().control("完成清单项 item-one");
    assert.equal(toggle.props.checked, false);
    toggle.props.onChange(); toggle.props.onChange();
    const changes = f.requests.filter(request => request.options.method === "PATCH");
    assert.equal(changes.length, 1);
    assert.deepEqual(JSON.parse(changes[0].options.body), {id: "checklist-one", version: 1, action: "set-completed", itemId: "item-one", completed: true});
    assert.equal(f.render().control("完成清单项 item-one").props.checked, false, "only a saved completion is displayed");
    assert.equal(f.render().control("完成清单项 item-one").props.disabled, true);
    pending.resolve(Response.json({checklist: record("checklist-one", {version: 2, items: [line("item-one", {completed: true})]})})); await nextTurn();
    assert.equal(f.render().control("完成清单项 item-one").props.checked, true);
    assert.match(text(f.render().tree), /已完成 1\/1 项/);
    fail = true;
    f.render().control("完成清单项 item-one").props.onChange(); await nextTurn();
    assert.equal(f.render().control("完成清单项 item-one").props.checked, true);
    assert.match(text(f.render().tree), /清单已被其他操作更新/);
    assert.equal(JSON.parse(f.requests.filter(request => request.options.method === "PATCH").at(-1).options.body).version, 2);
});

test("manual checklist items can be added repeatedly on an HTTP browser without crypto.randomUUID", async () => {
    const f = fixture({cryptoValue: {}});
    await f.open();
    f.render().button("新建发货清单").props.onClick();
    f.render().control("发货文案").props.onChange({target: {value: "SKU 商品 XS ×2"}});
    f.render().button("识别为清单").props.onClick();
    f.render().button("添加清单项").props.onClick();
    f.render().button("添加清单项").props.onClick();
    const removeButtons = () => f.render().all.filter(node => node.props?.["aria-label"]?.startsWith("删除清单项 "));
    const before = removeButtons().map(node => node.props["aria-label"]);
    assert.equal(new Set(before).size, 3);
    removeButtons()[1].props.onClick();
    f.render().button("添加清单项").props.onClick();
    const after = removeButtons().map(node => node.props["aria-label"]);
    assert.equal(new Set(after).size, 3);
    assert.ok(!after.includes(before[1]), "removed manual IDs are not reused");
    assert.ok(f.render().control("第 3 项数量"));
});

test("saved batch edits preserve content on conflicts and ignore a superseded detail response", async () => {
    const first = record("first"), second = record("second", {title: "第二批"});
    const slow = deferred(); let postpone = true;
    const f = fixture({records: [first, second], fetchResult: request => {
        if (request.url.includes("id=first") && postpone) return slow.promise;
        if (request.options.method === "PATCH") return Response.json({error: "版本已更新，请刷新"}, {status: 409});
    }});
    await f.open();
    const initial = f.render();
    initial.control("打开清单 first").props.onClick();
    initial.control("打开清单 second").props.onClick(); await nextTurn();
    slow.resolve(Response.json({checklist: first})); await nextTurn();
    assert.match(text(f.render().tree), /第二批/);
    f.render().button("编辑清单").props.onClick();
    f.render().control("清单名称").props.onChange({target: {value: "保留修改"}});
    f.render().control("第 1 项备注").props.onChange({target: {value: "请另外装袋"}});
    f.render().all.find(node => node.type === "form").props.onSubmit({preventDefault() {}}); await nextTurn();
    assert.equal(f.render().control("清单名称").props.value, "保留修改");
    assert.equal(f.render().control("第 1 项备注").props.value, "请另外装袋");
    assert.match(text(f.render().tree), /版本已更新，请刷新/);
    const body = JSON.parse(f.requests.find(request => request.options.method === "PATCH").options.body);
    assert.equal(body.id, "second"); assert.equal(body.version, 1); assert.equal(body.action, "update");
    assert.equal("sourceText" in body, false, "editing a saved list cannot rewrite its source text");
    postpone = false;
});

test("shipping checklist is mounted only in the administrator profile and retains accessible mobile controls", async () => {
    const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const mounted = [];
    function scan(node, owner = "") {
        if (ts.isFunctionDeclaration(node)) owner = node.name?.text ?? owner;
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "ShippingChecklistPanel") mounted.push(owner);
        ts.forEachChild(node, child => scan(child, owner));
    }
    scan(ast); assert.deepEqual(mounted, ["AdminProfile"]);
    const css = await readFile(new URL("../app/shipping-checklist-panel.module.css", import.meta.url), "utf8");
    assert.match(css, /font-size:\s*16px/);
    assert.match(css, /min-height:\s*44px/);
});
