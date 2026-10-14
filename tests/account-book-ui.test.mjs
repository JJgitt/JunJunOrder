import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { parseGrossProfitCents, validAccountingMonth } from "../lib/account-book.ts";
import { dateKey } from "../lib/time.ts";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../app/account-book-panel.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const record = (month, grossProfit, note = "") => ({ month, grossProfit, note, createdAt: "2026-10-01T01:00:00.000Z", updatedAt: "2026-10-02T01:00:00.000Z" });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function nodes(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
function text(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  return [node.props?.children].flat(Infinity).map(text).join("");
}

// Invoke the shipped component's event handlers with deterministic React hooks.
// Fetch responses are isolated so no accounting or production data is changed.
function fixture({ records = [], getResult, postResult } = {}) {
  const states = [], refs = [], effects = [], requests = [], notices = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, queuedEffects = [];
  const useState = initial => {
    const key = stateIndex++;
    if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial;
    return [states[key], value => { states[key] = typeof value === "function" ? value(states[key]) : value; }];
  };
  const useRef = initial => {
    const key = refIndex++;
    return refs[key] ?? (refs[key] = { current: initial });
  };
  const useEffect = (callback, dependencies) => {
    const key = effectIndex++;
    const old = effects[key];
    if (!old || dependencies.some((value, index) => !Object.is(value, old.dependencies[index]))) {
      queuedEffects.push(() => {
        old?.cleanup?.();
        effects[key] = { dependencies, cleanup: callback() };
      });
    }
  };
  const createElement = (type, props) => ({ type, props });
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") {
      if (postResult) return typeof postResult === "function" ? postResult(requests.at(-1)) : postResult;
      const body = JSON.parse(options.body);
      return Response.json({ record: record(body.month, Number(body.grossProfit), body.note) });
    }
    return getResult ? typeof getResult === "function" ? getResult(requests.at(-1)) : getResult : Response.json({ records });
  };
  const styles = new Proxy({}, { get: (_target, key) => String(key) });
  const modules = {
    react: { useState, useRef, useEffect, useId: () => "account-book-test" },
    "react/jsx-runtime": { jsx: createElement, jsxs: createElement },
    "@/lib/account-book": { parseGrossProfitCents, validAccountingMonth },
    "@/lib/time": { dateKey },
    "./server-clock": { useServerClock: () => ({ now: "2026-09-30T17:30:00.000Z", timeZone: "Asia/Shanghai", dateTime: value => value }) },
    "./account-book-panel.module.css": { __esModule: true, default: styles },
  };
  const exports = {};
  new Function("require", "exports", "fetch", code)(id => modules[id] ?? require(id), exports, fetch);
  function render() {
    stateIndex = 0; refIndex = 0; effectIndex = 0; queuedEffects = [];
    const tree = exports.default({ onNotify: message => { notices.push(message); } });
    const all = nodes(tree);
    queuedEffects.forEach(run => run());
    return {
      tree, all,
      entry: all.find(node => node.type === "button" && node.props["aria-expanded"] !== undefined),
      body: all.find(node => node.props.id === "account-book-test"),
      form: all.find(node => node.type === "form"),
      month: all.find(node => node.type === "input" && node.props.type === "month"),
      amount: all.find(node => node.type === "input" && node.props.inputMode === "decimal"),
      note: all.find(node => node.type === "textarea"),
      save: all.find(node => node.type === "button" && node.props.type === "submit"),
      sign: all.find(node => node.props["aria-label"] === "切换毛利正负号"),
      retry: all.find(node => node.type === "button" && text(node) === "重新加载"),
      alerts: all.filter(node => node.props.role === "alert"),
      history: all.filter(node => node.type === "button" && node.props["aria-label"]?.startsWith("编辑 ")),
    };
  }
  return {
    render, requests, notices,
    open: async () => { render().entry.props.onClick(); render(); await nextTurn(); return render(); },
    submit: () => render().form.props.onSubmit({ preventDefault() {} }),
    unmount: () => { effects.forEach(effect => effect.cleanup?.()); },
  };
}

test("account book loads only when opened and defaults to the server timezone month", async () => {
  const f = fixture({ records: [record("2026-10", 123.45, "当月已记账")] });
  const collapsed = f.render();
  assert.equal(collapsed.body.props.hidden, true);
  assert.equal(f.requests.length, 0);
  assert.equal(collapsed.month.props.value, "2026-10", "server is already in October while UTC is still September");
  const opened = await f.open();
  assert.equal(opened.body.props.hidden, false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/api/account-book");
  assert.equal(f.requests[0].options.cache, "no-store");
  assert.equal(opened.amount.props.value, "123.45");
  assert.equal(opened.note.props.value, "当月已记账");
  assert.equal(text(opened.save), "更新本月记录");
  opened.entry.props.onClick(); f.render().entry.props.onClick(); f.render();
  await nextTurn();
  assert.equal(f.requests.length, 1, "folding and unfolding must keep the loaded account book");
});

test("failed loading cannot overwrite unseen records and a retry restores editing", async () => {
  let attempt = 0;
  const f = fixture({ getResult: () => ++attempt === 1
    ? Response.json({ error: "加载失败" }, { status: 503 })
    : Response.json({ records: [record("2026-10", 500, "已有账目")] }) });
  const failed = await f.open();
  assert.match(text(failed.tree), /加载失败/);
  assert.equal(failed.save.props.disabled, true);
  assert.equal(failed.month.props.disabled, true);
  assert.equal(failed.amount.props.disabled, true);
  f.submit(); await nextTurn();
  assert.equal(f.requests.length, 1);
  failed.retry.props.onClick(); f.render(); await nextTurn();
  assert.equal(f.render().amount.props.value, "500.00");
  assert.equal(f.render().save.props.disabled, false);
  assert.equal(f.render().alerts.length, 0);
});

test("selecting saved months prefills only that month; unrecorded months start empty", async () => {
  const f = fixture({ records: [record("2026-10", 100, "十月"), record("2026-09", -20.5, "九月亏损")] });
  await f.open();
  f.render().month.props.onChange({ target: { value: "2026-09" } });
  assert.equal(f.render().amount.props.value, "-20.50");
  assert.equal(f.render().note.props.value, "九月亏损");
  f.render().month.props.onChange({ target: { value: "2026-08" } });
  assert.equal(f.render().amount.props.value, "");
  assert.equal(f.render().note.props.value, "");
  assert.equal(f.render().save.props.disabled, true);
  assert.equal(text(f.render().save), "保存本月记录");
  f.render().history.find(button => button.props["aria-label"].includes("9 月")).props.onClick();
  assert.equal(f.render().month.props.value, "2026-09");
  assert.equal(f.render().amount.props.value, "-20.50");
});

test("saving accepts zero and negative profit and replaces the selected history row", async () => {
  const f = fixture({ records: [record("2026-10", 100)] });
  await f.open();
  f.render().amount.props.onChange({ target: { value: "0" } });
  assert.equal(f.render().save.props.disabled, false, "zero is a valid saved amount");
  f.submit(); await nextTurn();
  assert.equal(f.render().amount.props.value, "0.00");
  assert.equal(f.render().history.length, 1);
  f.render().amount.props.onChange({ target: { value: " +12.34 " } });
  f.render().sign.props.onClick();
  assert.equal(f.render().amount.props.value, "-12.34");
  f.render().note.props.onChange({ target: { value: "  本月亏损  " } });
  f.submit(); await nextTurn();
  assert.deepEqual(f.requests.filter(request => request.options.method === "POST").map(request => JSON.parse(request.options.body)), [
    { month: "2026-10", grossProfit: "0", note: "" },
    { month: "2026-10", grossProfit: "-12.34", note: "本月亏损" },
  ]);
  assert.equal(f.render().history.length, 1);
  assert.equal(f.render().amount.props.value, "-12.34");
  assert.equal(f.render().note.props.value, "本月亏损");
  assert.equal(f.notices.length, 2);
});

test("saving failure keeps the draft, prevents duplicate requests, and allows an explicit retry", async () => {
  const waiting = deferred();
  let posts = 0;
  const f = fixture({ postResult: () => ++posts === 1 ? waiting.promise : Response.json({ record: record("2026-10", -50, "保留的说明") }) });
  await f.open();
  f.render().amount.props.onChange({ target: { value: "-50" } });
  f.render().note.props.onChange({ target: { value: "保留的说明" } });
  const stale = f.render().form;
  stale.props.onSubmit({ preventDefault() {} });
  stale.props.onSubmit({ preventDefault() {} });
  assert.equal(posts, 1);
  assert.equal(f.render().save.props.disabled, true);
  assert.equal(f.render().month.props.disabled, true);
  waiting.resolve(Response.json({ error: "保存暂时失败" }, { status: 503 }));
  await nextTurn();
  assert.match(text(f.render().tree), /保存暂时失败/);
  assert.equal(f.render().amount.props.value, "-50");
  assert.equal(f.render().note.props.value, "保留的说明");
  assert.equal(f.notices.length, 0);
  assert.equal(f.render().save.props.disabled, false);
  f.submit(); await nextTurn();
  assert.equal(posts, 2);
  assert.equal(f.render().amount.props.value, "-50.00");
  assert.equal(f.render().alerts.length, 0);
  assert.equal(f.notices.length, 1);
});

test("invalid or wrong-month save responses retain the draft and do not report success", async () => {
  for (const value of [null, record("2026-09", 100), { ...record("2026-10", 100), grossProfit: "100" }]) {
    const f = fixture({ postResult: Response.json({ record: value }) });
    await f.open();
    f.render().amount.props.onChange({ target: { value: "25.50" } });
    f.submit(); await nextTurn();
    assert.equal(f.render().amount.props.value, "25.50");
    assert.equal(f.render().history.length, 0);
    assert.match(text(f.render().tree), /保存结果异常/);
    assert.equal(f.notices.length, 0);
  }
});

test("unmounting aborts pending saves and ignores their late results", async () => {
  const pending = deferred();
  const f = fixture({ postResult: pending.promise });
  await f.open();
  f.render().amount.props.onChange({ target: { value: "88" } });
  f.submit();
  const request = f.requests.find(item => item.options.method === "POST");
  assert.equal(request.options.signal.aborted, false);
  f.unmount();
  assert.equal(request.options.signal.aborted, true);
  pending.resolve(Response.json({ record: record("2026-10", 88) }));
  await nextTurn();
  assert.equal(f.notices.length, 0);
  assert.equal(f.render().history.length, 0);
  assert.equal(f.render().amount.props.value, "88", "a detached panel must not apply the late response to its draft");
});
