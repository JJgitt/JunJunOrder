import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

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
function sheetFixture(response) {
  const state = [], refs = [], saved = [], requests = [];
  let index = 0, refIndex = 0;
  const useState = initial => {
    const key = index++;
    if (!(key in state)) state[key] = initial;
    return [state[key], value => { state[key] = value; }];
  };
  const useRef = initial => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial });
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  const fetch = async (url, options) => { requests.push({ url, options }); return response; };
  const Sheet = new Function("React", "useState", "useRef", "useEffect", "fetch", "Modal", "OrderImages", "money", `${sheetCode}; return SettlementProofSheet;`)(React, useState, useRef, () => {}, fetch, "Modal", "OrderImages", value => `¥${value}`);
  function nodes(node) {
    if (!node || typeof node !== "object") return [];
    return [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(nodes)];
  }
  function render() {
    index = 0; refIndex = 0;
    const tree = Sheet({ order: { id: "test-order", settledAmount: 100, settlementProofs: [] }, onClose: () => {}, onSubmit: async (...args) => { saved.push(args); return true; } });
    const all = nodes(tree);
    return { file: all.find(n => n.type === "input" && n.props.type === "file"), amount: all.find(n => n.type === "input" && n.props.inputMode === "decimal"), save: all.find(n => n.type === "button" && n.props.className?.includes("primary-button")) };
  }
  return { render, requests, saved, upload: () => render().file.props.onChange({ target: { files: [new File(["proof"], "proof.png", { type: "image/png" })], value: "proof.png" } }) };
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
