import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { prepareSettlementProof } from "../lib/settlement-proof-upload.ts";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../app/api/settlements/proof/route.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

// Execute the real handler with transactional in-memory persistence and file I/O doubles.
function fixture({ failAudit = false, settled = true, role = "admin", hasProof = true } = {}) {
  const tables = { purchaseOrders: { id: "id" }, orderImages: { id: "id", orderId: "orderId", kind: "kind" }, auditLogs: {} };
  let state = { order: { id: "test-order", settled, settledAmountCents: 10000, settledAt: "2026-09-01", settledBy: "original-admin", status: "已入库" }, images: hasProof ? [{ id: "old-image", objectKey: "old.png" }] : [], audits: [] };
  const files = new Set(hasProof ? ["/uploads/old.png"] : []);
  const db = { transaction: async callback => {
    const next = structuredClone(state);
    const tx = {
      select: () => ({ from: table => ({ where: () => ({ for: () => table === tables.purchaseOrders ? { limit: async () => [structuredClone(next.order)] } : Promise.resolve(structuredClone(next.images)) }) }) }),
      delete: () => ({ where: async () => { next.images = []; } }),
      insert: table => ({ values: async value => {
        if (table === tables.auditLogs) { if (failAudit) throw new Error("audit failed"); next.audits.push(value); }
        else next.images.push(value);
      } }),
      update: () => ({ set: patch => ({ where: async () => { Object.assign(next.order, patch); } }) }),
    };
    const result = await callback(tx);
    state = next;
    return result;
  } };
  const modules = {
    "node:fs/promises": { mkdir: async () => {}, writeFile: async path => { files.add(path); }, unlink: async path => { files.delete(path); } },
    "@/db": { getDb: () => db },
    "@/db/schema": tables,
    "drizzle-orm": { eq: () => null, and: () => null, inArray: () => null },
    "@/lib/file-storage": { imageExtension: type => type === "image/png" ? ".png" : null, uploadPath: key => `/uploads/${key}` },
    "@/lib/auth": {
      assertSameOrigin: () => {}, requireAppUser: async () => ({ id: "admin", role }),
      requireAdmin: user => { if (user.role !== "admin") throw new Response(null, { status: 403 }); },
      routeError: error => error instanceof Response ? error : Response.json({ error: error.message }, { status: 500 }),
    },
  };
  const exports = {};
  new Function("require", "exports", code)(id => modules[id] ?? require(id), exports);
  return {
    get state() { return state; }, files,
    request: async amount => {
      const form = new FormData();
      form.set("orderId", "test-order");
      form.set("proof", new File(["test-image"], "proof.png", { type: "image/png" }));
      if (amount !== undefined) form.set("amount", amount);
      return exports.POST(new Request("http://localhost/api/settlements/proof", { method: "POST", body: form }));
    },
  };
}

for (const hasProof of [false, true]) {
  test(`${hasProof ? "replace" : "add"} proof saves confirmed amount and preserves settlement history`, async () => {
    const f = fixture({ hasProof });
    assert.equal((await f.request("258.50")).status, 200);
    assert.equal(f.state.order.settledAmountCents, 25850);
    assert.equal(f.state.order.settledAt, "2026-09-01");
    assert.equal(f.state.order.settledBy, "original-admin");
    assert.equal(f.state.order.status, "已入库");
    assert.equal(f.state.order.settled, true);
    assert.equal(f.state.images.length, 1);
    assert.equal(f.files.size, 1);
    assert.equal(f.files.has("/uploads/old.png"), false);
    const audit = JSON.parse(f.state.audits[0].detailJson);
    assert.deepEqual(audit.before, { settledAmountCents: 10000 });
    assert.deepEqual(audit.after, { settledAmountCents: 25850 });
  });
}

test("omitted amount preserves existing value; explicit blank clears it", async () => {
  const f = fixture();
  assert.equal((await f.request()).status, 200);
  assert.equal(f.state.order.settledAmountCents, 10000);
  assert.equal((await f.request("")).status, 200);
  assert.equal(f.state.order.settledAmountCents, null);
});

test("invalid amounts do not alter the proof or amount", async () => {
  for (const amount of ["NaN", "Infinity", "-1", "0", "0.001", "21474836.48", "abc"]) {
    const f = fixture();
    assert.equal((await f.request(amount)).status, 400, amount);
    assert.equal(f.state.order.settledAmountCents, 10000);
    assert.equal(f.state.images[0].id, "old-image");
    assert.deepEqual([...f.files], ["/uploads/old.png"]);
  }
});

test("a failed transaction retains old proof and amount and removes the new file", async () => {
  const f = fixture({ failAudit: true });
  assert.equal((await f.request("258.50")).status, 500);
  assert.equal(f.state.order.settledAmountCents, 10000);
  assert.equal(f.state.images[0].id, "old-image");
  assert.deepEqual([...f.files], ["/uploads/old.png"]);
});

test("unsettled orders and buyers cannot update proof or amount", async () => {
  for (const [options, status] of [[{ settled: false }, 409], [{ role: "buyer" }, 403]]) {
    const f = fixture(options);
    assert.equal((await f.request("258.50")).status, status);
    assert.equal(f.state.order.settledAmountCents, 10000);
    assert.deepEqual([...f.files], ["/uploads/old.png"]);
  }
});

// Exercise the actual component event handlers without contacting the paid vision service.
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const sheetSource = page.slice(page.indexOf("function SettlementProofSheet("), page.indexOf("function RevertReceiveSheet("));
const sheetCode = ts.transpileModule(sheetSource, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
const firstSheetSource = page.slice(page.indexOf("function SettlementSheet("), page.indexOf("function SettlementAmountSheet("));
const firstSheetCode = ts.transpileModule(firstSheetSource, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(24).fill(0)]);
const pngFile = (type = "image/png") => new File([pngBytes], "proof.png", { type, lastModified: 123456789 });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function sheetFixture(response, { first = false } = {}) {
  const state = [], refs = [], saved = [], requests = [], effects = [];
  let index = 0, refIndex = 0, effectIndex = 0;
  const useState = initial => {
    const key = index++;
    if (!(key in state)) state[key] = initial;
    return [state[key], value => { state[key] = typeof value === "function" ? value(state[key]) : value; }];
  };
  const useRef = initial => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial });
  const useEffect = callback => {
    const key = effectIndex++;
    if (!(key in effects)) effects[key] = callback();
  };
  const close = () => { effects.forEach(cleanup => cleanup?.()); };
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  const fetch = async (url, options) => { requests.push({ url, options }); return typeof response === "function" ? response(requests.length) : response; };
  const Sheet = new Function("React", "useState", "useRef", "useEffect", "fetch", "Modal", "OrderImages", "money", "prepareSettlementProof", `${first ? firstSheetCode : sheetCode}; return ${first ? "SettlementSheet" : "SettlementProofSheet"};`)(React, useState, useRef, useEffect, fetch, "Modal", "OrderImages", value => `¥${value}`, prepareSettlementProof);
  function nodes(node) {
    if (!node || typeof node !== "object") return [];
    return [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(nodes)];
  }
  function render() {
    index = 0; refIndex = 0; effectIndex = 0;
    const tree = Sheet({ order: { id: "test-order", amount: 100, purchaser: "test-buyer", status: "在途", items: [], settledAmount: 100, settlementProofs: [] }, onClose: close, onSubmit: async (...args) => { saved.push(args); return true; } });
    const all = nodes(tree);
    return {
      tree,
      text: all.flatMap(n => (n.props?.children ?? []).flat(Infinity).filter(value => typeof value === "string")).join(" "),
      file: all.find(n => n.type === "input" && n.props.type === "file"),
      amount: all.find(n => n.type === "input" && n.props.inputMode === "decimal"),
      save: all.find(n => n.type === "button" && n.props.className?.includes("primary-button")),
      retry: all.find(n => n.type === "button" && n.props.className?.includes("settlement-recognize-retry")),
      remove: all.find(n => n.type === "button" && n.props.className?.includes("settlement-proof-clear")),
    };
  }
  return {
    render, requests, saved,
    upload: (file = pngFile()) => {
      const target = { files: file ? [file] : [], value: file?.name ?? "" };
      render().file.props.onChange({ target });
      return target;
    },
  };
}

test("selecting a proof automatically fills recognized amount, then saves only after confirmation", async () => {
  const f = sheetFixture(Response.json({ data: { amount: 258.5 } }));
  f.upload();
  assert.equal(f.render().save.props.disabled, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests[0].url, "/api/settlements/recognize");
  assert.equal(f.render().amount.props.value, "258.50");
  assert.equal(f.saved.length, 0);
  f.render().amount.props.onChange({ target: { value: "260.00" } });
  f.render().save.props.onClick();
  assert.equal(f.saved[0][2], 260);
});

test("recognition failure preserves the original amount; blank can explicitly clear it", async () => {
  const f = sheetFixture(Response.json({ error: "识别失败" }, { status: 502 }));
  f.upload();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.render().amount.props.value, "100.00");
  assert.equal(f.render().save.props.disabled, false);
  f.render().save.props.onClick();
  assert.equal(f.saved[0][2], undefined);
  await new Promise(resolve => setImmediate(resolve));
  f.render().amount.props.onChange({ target: { value: "" } });
  f.render().save.props.onClick();
  assert.equal(f.saved[1][2], null);
});

test("settlement proof preparation recovers supported image formats from missing or generic MIME", async () => {
  const enc = value => [...new TextEncoder().encode(value)];
  const formats = [
    [pngBytes, "image/png"],
    [[255, 216, 255, 224], "image/jpeg"],
    [enc("GIF89a"), "image/gif"],
    [[...enc("RIFF"), 24, 0, 0, 0, ...enc("WEBP")], "image/webp"],
    [[0, 0, 0, 24, ...enc("ftypheic"), 0, 0, 0, 0, ...enc("heic")], "image/heic"],
    [[0, 0, 0, 24, ...enc("ftypmif1"), 0, 0, 0, 0, ...enc("mif1")], "image/heif"],
  ];
  for (const [bytes, expectedType] of formats) {
    for (const type of ["", "application/octet-stream"]) {
      const original = new File([Uint8Array.from(bytes)], "mobile-picture", { type, lastModified: 123456789 });
      const prepared = await prepareSettlementProof(original);
      assert.equal(prepared.type, expectedType);
      assert.equal(prepared.name, original.name);
      assert.equal(prepared.lastModified, original.lastModified);
      assert.deepEqual(await prepared.arrayBuffer(), await original.arrayBuffer());
    }
  }
  const original = pngFile();
  assert.equal(await prepareSettlementProof(original), original);
});

test("settlement proof preparation rejects empty, oversized and unknown data", async () => {
  for (const file of [
    new File([], "empty.png", { type: "image/png" }),
    new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
    new File(["not an image"], "fake.png"),
    new File(["<svg></svg>"], "vector.svg", { type: "image/svg+xml" }),
  ]) {
    await assert.rejects(() => prepareSettlementProof(file), file.name);
  }
});

for (const type of ["image/png", ""]) {
  test(`first settlement recognizes ${type || "missing MIME"} image and saves the normalized proof`, async () => {
    const result = deferred();
    const f = sheetFixture(result.promise, { first: true });
    const original = pngFile(type);
    const input = f.upload(original);
    assert.equal(input.value, "", "same picture must be selectable again");
    await nextTurn();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url, "/api/settlements/recognize");
    assert.equal(f.requests[0].options.body.get("image").type, "image/png");
    assert.match(f.render().text, /正在识别/);
    assert.equal(f.render().amount.props.disabled, true);
    assert.equal(f.render().save.props.disabled, true);
    result.resolve(Response.json({ data: { amount: 258.5 } }));
    await nextTurn();
    assert.equal(f.render().amount.props.value, "258.50");
    assert.equal(f.saved.length, 0);
    f.render().save.props.onClick();
    assert.equal(f.saved[0][1], 258.5);
    assert.equal(f.saved[0][2].type, "image/png");
    assert.deepEqual(await f.saved[0][2].arrayBuffer(), await original.arrayBuffer());
  });
}

test("first settlement clears the picker for same-picture retry and preserves proof when picker is canceled", async () => {
  const f = sheetFixture(() => Response.json({ data: { amount: 88 } }), { first: true });
  const file = pngFile();
  assert.equal(f.upload(file).value, "");
  await nextTurn();
  assert.equal(f.upload(file).value, "");
  await nextTurn();
  assert.equal(f.requests.length, 2);
  f.upload(null);
  await nextTurn();
  assert.equal(f.requests.length, 2);
  f.render().save.props.onClick();
  assert.equal(f.saved[0][2], file);
});

for (const first of [true, false]) {
  test(`${first ? "first settlement" : "proof replacement"} can retry recognition after failure`, async () => {
    const f = sheetFixture(attempt => attempt === 1 ? Response.json({ error: "服务超时" }, { status: 502 }) : Response.json({ data: { amount: 120.5 } }), { first });
    f.upload();
    await nextTurn();
    assert.equal(f.requests.length, 1);
    assert.match(f.render().text, /服务超时/);
    assert.ok(f.render().retry, "an explicit retry action must be available");
    assert.equal(Boolean(f.render().retry.props.disabled), false);
    f.render().retry.props.onClick();
    await nextTurn();
    assert.equal(f.requests.length, 2);
    assert.equal(f.render().amount.props.value, "120.50");
  });
}

test("invalid first settlement proof never calls recognition or retains an invalid attachment", async () => {
  const f = sheetFixture(Response.json({ data: { amount: 1 } }), { first: true });
  f.upload(new File(["not an image"], "fake.png"));
  await nextTurn();
  assert.equal(f.requests.length, 0);
  assert.equal(f.render().amount.props.value, "");
  f.render().save.props.onClick();
  assert.equal(f.saved[0][2], undefined);
});

for (const action of ["remove", "close"]) {
  test(`first settlement ignores late recognition after ${action}`, async () => {
    const result = deferred();
    const f = sheetFixture(result.promise, { first: true });
    f.upload();
    await nextTurn();
    assert.equal(f.requests.length, 1);
    if (action === "remove") f.render().remove.props.onClick();
    else f.render().tree.props.onClose();
    result.resolve(Response.json({ data: { amount: 999 } }));
    await nextTurn();
    assert.equal(f.render().amount.props.value, "");
    assert.equal(f.saved.length, 0);
  });
}

test("first settlement keeps both amount and screenshot optional and rejects invalid recognition values", async () => {
  const empty = sheetFixture(undefined, { first: true });
  empty.render().save.props.onClick();
  assert.deepEqual(empty.saved[0], ["test-order", undefined, undefined]);
  for (const amount of [0, -1, "88.00", null]) {
    const f = sheetFixture(Response.json({ data: { amount } }), { first: true });
    f.upload();
    await nextTurn();
    assert.equal(f.render().amount.props.value, "", String(amount));
    assert.equal(f.render().save.props.disabled, false);
    f.render().save.props.onClick();
    assert.equal(f.saved[0][1], undefined);
    assert.ok(f.saved[0][2] instanceof File);
  }
});
