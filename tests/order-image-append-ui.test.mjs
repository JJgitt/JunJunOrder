import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const uploadSource = await readFile(new URL("../lib/order-image-upload.ts", import.meta.url), "utf8");
const compile = source => ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const uploadExports = {};
new Function("exports", compile(uploadSource))(uploadExports);
const { orderImageUploadError } = uploadExports;

function componentSource(start, end) {
  const first = page.indexOf(start), last = page.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Expected component boundaries: ${start}, ${end}`);
  return page.slice(first, last);
}

const sheetCode = compile(componentSource("function OrderImageUploadSheet(", "function SettlementSheet("));
const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
function nodes(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(nodes)];
}
function text(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  return (node.props?.children ?? []).flat(Infinity).map(text).join("");
}
function hooks() {
  const state = [], refs = [];
  let stateIndex = 0, refIndex = 0;
  return {
    reset: () => { stateIndex = 0; refIndex = 0; },
    useState: initial => {
      const key = stateIndex++;
      if (!(key in state)) state[key] = typeof initial === "function" ? initial() : initial;
      return [state[key], value => { state[key] = typeof value === "function" ? value(state[key]) : value; }];
    },
    useRef: initial => {
      const key = refIndex++;
      return refs[key] ?? (refs[key] = { current: initial });
    },
  };
}
const file = (name = "additional.png", size = 100, type = "image/png") => ({ name, size, type });
const settlePromises = () => new Promise(resolve => setImmediate(resolve));

function sheetFixture(submit = async () => {}) {
  const hook = hooks(), saved = [];
  let closed = 0;
  const oldImages = [{ id: "existing-image", fileName: "existing.png", url: "/api/files/existing-image" }];
  const Sheet = new Function("React", "useState", "useRef", "Modal", "OrderImages", "orderImageUploadError", `${sheetCode}; return OrderImageUploadSheet;`)(
    React, hook.useState, hook.useRef, "Modal", "OrderImages", orderImageUploadError,
  );
  function render() {
    hook.reset();
    const tree = Sheet({
      order: { id: "test-order", images: oldImages },
      onClose: () => { closed++; },
      onSubmit: async (...args) => { saved.push(args); await submit(...args); },
    });
    const all = nodes(tree);
    return {
      tree, all,
      picker: all.find(node => node.type === "input" && node.props.type === "file"),
      save: all.find(node => node.type === "button" && node.props.className === "primary-button"),
      cancel: all.find(node => node.type === "button" && node.props.className === "secondary-button"),
      remove: all.filter(node => node.type === "button" && node.props["aria-label"]?.startsWith("移除图片 ")),
      error: all.find(node => node.props.role === "alert"),
      gallery: all.find(node => node.type === "OrderImages"),
    };
  }
  function choose(selected) {
    const target = { files: selected, value: "local-selection" };
    render().picker.props.onChange({ target });
    assert.equal(target.value, "", "input resets so the same image can be selected again");
  }
  return { render, choose, saved, oldImages, get closed() { return closed; } };
}

test("additional images are kept local until confirmation; cancel does not upload", () => {
  const f = sheetFixture();
  assert.equal(f.render().save.props.disabled, true);
  const selected = [file("first.png"), file("second.jpg", 100, "image/jpeg")];
  f.choose(selected);
  const view = f.render();
  assert.equal(view.save.props.disabled, false);
  assert.equal(view.remove.length, 2);
  assert.strictEqual(view.gallery.props.images, f.oldImages);
  assert.match(text(view.tree), /first\.png/);
  assert.match(text(view.tree), /second\.jpg/);
  assert.equal(f.saved.length, 0);
  view.cancel.props.onClick();
  assert.equal(f.closed, 1);
  assert.equal(f.saved.length, 0);
});

test("confirmation submits selected files once and prevents duplicate saves while busy", async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = sheetFixture(() => waiting), selected = [file()];
  f.choose(selected);
  const staleSave = f.render().save;
  staleSave.props.onClick();
  staleSave.props.onClick();
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0][0], "test-order");
  assert.deepEqual(f.saved[0][1], selected);
  const pending = f.render();
  assert.equal(pending.save.props.disabled, true);
  assert.equal(pending.cancel.props.disabled, true);
  assert.equal(pending.picker.props.disabled, true);
  assert.equal(pending.remove[0].props.disabled, true);
  pending.tree.props.onClose();
  assert.equal(f.closed, 0, "modal closing must not interrupt an active save");
  finish();
  await settlePromises();
  assert.equal(f.render().save.props.disabled, false);
  assert.equal(f.render().error, undefined);
});

test("upload failure retains selection and displays an inline error for retry", async () => {
  let attempts = 0;
  const f = sheetFixture(async () => { if (++attempts === 1) throw new Error("服务器暂时不可用"); });
  f.choose([file("retry.png")]);
  f.render().save.props.onClick();
  await settlePromises();
  const failed = f.render();
  assert.equal(text(failed.error), "服务器暂时不可用");
  assert.match(text(failed.tree), /retry\.png/);
  assert.equal(failed.remove.length, 1);
  assert.equal(failed.save.props.disabled, false);
  assert.equal(f.closed, 0);
  failed.save.props.onClick();
  await settlePromises();
  assert.equal(f.saved.length, 2);
  assert.equal(f.render().error, undefined);
});

test("invalid replacement selections retain valid files and cannot trigger an upload", () => {
  const mb = 1024 * 1024;
  const cases = [
    { files: [file(), file(), file(), file()], message: /最多上传 3 张/ },
    { files: [file("large.png", 5 * mb + 1)], message: /单张.*5MB/ },
    { files: [file("first.png", 4 * mb), file("second.png", 4 * mb + 1)], message: /总大小.*8MB/ },
    { files: [file("not-image.txt", 100, "text/plain")], message: /仅支持/ },
    { files: [file("empty.png", 0)], message: /不能为空/ },
  ];
  for (const item of cases) {
    const f = sheetFixture();
    f.choose([file("valid.png")]);
    f.choose(item.files);
    const view = f.render();
    assert.match(text(view.error), item.message);
    assert.equal(view.remove.length, 1);
    assert.match(text(view.tree), /valid\.png/);
    assert.equal(f.saved.length, 0);
  }
});

test("empty confirmation is rejected and dismissing the picker preserves local selection", () => {
  const f = sheetFixture();
  f.render().save.props.onClick();
  assert.match(text(f.render().error), /请选择订单图片/);
  assert.equal(f.saved.length, 0);
  f.choose([file("keep.png")]);
  f.choose(null);
  assert.equal(f.render().remove.length, 1);
  assert.match(text(f.render().tree), /keep\.png/);
  assert.equal(f.saved.length, 0);
});

test("removing selected images changes only the local selection", () => {
  const f = sheetFixture();
  f.choose([file("first.png"), file("second.png")]);
  f.render().remove[0].props.onClick();
  assert.equal(f.render().remove.length, 1);
  assert.doesNotMatch(text(f.render().tree), /first\.png/);
  assert.match(text(f.render().tree), /second\.png/);
  f.render().remove[0].props.onClick();
  assert.equal(f.render().remove.length, 0);
  assert.equal(f.render().save.props.disabled, true);
  assert.equal(f.saved.length, 0);
  assert.equal(f.oldImages.length, 1);
});

test("an order without existing images still exposes the supplement action", () => {
  const hook = hooks();
  const imageCode = compile(componentSource("function OrderImages(", "function ManualReceiveSheet("));
  const Gallery = new Function("React", "useState", "useRef", "useEffect", "Image", `${imageCode}; return OrderImages;`)(
    React, hook.useState, hook.useRef, () => {}, "Image",
  );
  let clicked = 0;
  const tree = Gallery({ images: [], emptyText: "暂无订单图片，可继续补充", actionLabel: "补充图片", onAction: () => { clicked++; } });
  assert.match(text(tree), /暂无订单图片，可继续补充/);
  const action = nodes(tree).find(node => node.type === "button" && text(node) === "补充图片");
  assert.ok(action);
  action.props.onClick();
  assert.equal(clicked, 1);
});

test("the supplement entry is available to both admin and buyer order details", () => {
  const detail = componentSource("function OrderDetail(", "function OrderImageUploadSheet(");
  assert.match(detail, /<OrderImages images=\{order\.images\} emptyText="暂无订单图片，可继续补充" actionLabel="补充图片" onAction=\{onOrderImages\}/);
  assert.match(page, /onOrderImages=\{\(\) => setOverlay\("order-images"\)\}/);
  assert.match(page, /\{overlay === "order-images" && selected &&\s*<OrderImageUploadSheet/);
});

test("successful appending updates only target order images and preserves list state", async () => {
  const appended = [{ id: "new-image", fileName: "additional.png", url: "/api/files/new-image" }];
  const untouched = { id: "other-order", images: [{ id: "other-image" }], amount: 200 };
  const original = { id: "test-order", images: [{ id: "old-image" }], status: "已入库", settled: true, amount: 100 };
  let orders = [original, untouched];
  const overlays = [], notifications = [], requests = [];
  const appendCode = compile(componentSource("async function appendOrderImages(", "async function run("));
  const append = new Function("uploadOrderFiles", "setOrders", "setOverlay", "notify", `${appendCode}; return appendOrderImages;`)(
    async (...args) => { requests.push(args); return { images: appended, imageIds: ["new-image"] }; },
    value => { orders = value(orders); },
    value => { overlays.push(value); },
    value => { notifications.push(value); },
  );
  const selected = [file()];
  await append("test-order", selected);
  assert.deepEqual(requests, [["test-order", selected]]);
  assert.deepEqual(orders[0], { ...original, images: [...original.images, ...appended] });
  assert.strictEqual(orders[1], untouched);
  assert.deepEqual(overlays, ["detail"]);
  assert.match(notifications[0], /原图片已保留/);
  assert.doesNotMatch(appendCode, /loadSnapshot|refreshOrders|setOrderFilters|setFilters|location\.reload/);
});

test("failed appending does not change orders or navigate away from the supplement sheet", async () => {
  const appendCode = compile(componentSource("async function appendOrderImages(", "async function run("));
  let mutations = 0;
  const append = new Function("uploadOrderFiles", "setOrders", "setOverlay", "notify", `${appendCode}; return appendOrderImages;`)(
    async () => { throw new Error("保存失败"); },
    () => { mutations++; }, () => { mutations++; }, () => { mutations++; },
  );
  await assert.rejects(append("test-order", [file()]), /保存失败/);
  assert.equal(mutations, 0);
});

test("order submission validates attached images before creation; no-image orders still submit", async () => {
  const uploadCode = compile(componentSource("async function upload(", "if (loading)"));
  const mb = 1024 * 1024;
  const invalidSelections = [
    [file(), file(), file(), file()],
    [file("large.png", 5 * mb + 1)],
    [file("one.png", 4 * mb), file("two.png", 4 * mb + 1)],
    [file("invalid.txt", 100, "text/plain")],
  ];
  const order = { id: "new-order", purchaserId: "admin", platform: "淘宝", platformNo: "123", items: [] };
  function fixture() {
    const mutations = [], uploads = [], notifications = [], transitions = [];
    let loads = 0;
    const upload = new Function(
      "orderImageUploadError", "orders", "currentUser", "mutate", "uploadOrderFiles", "load", "setSelectedId", "setUploadNonce", "setAdminTab", "setBuyerTab", "notify",
      `${uploadCode}; return upload;`,
    )(
      orderImageUploadError, [], { id: "admin", role: "admin" },
      async (...args) => { mutations.push(args); return { createdOrderId: "new-order" }; },
      async (...args) => { uploads.push(args); },
      async () => { loads++; },
      value => { transitions.push(["selected", value]); },
      () => { transitions.push(["nonce"]); },
      value => { transitions.push(["adminTab", value]); },
      value => { transitions.push(["buyerTab", value]); },
      value => { notifications.push(value); },
    );
    return { upload, mutations, uploads, notifications, transitions, get loads() { return loads; } };
  }
  for (const selection of invalidSelections) {
    const f = fixture();
    await f.upload(order, selection);
    assert.equal(f.mutations.length, 0, "invalid attachments must not create or edit an order");
    assert.equal(f.uploads.length, 0);
    assert.equal(f.loads, 0);
    assert.equal(f.transitions.length, 0);
    assert.deepEqual(f.notifications, [orderImageUploadError(selection)]);
  }
  const f = fixture();
  await f.upload(order, []);
  assert.equal(f.mutations.length, 1);
  assert.equal(f.mutations[0][0], "create-order");
  assert.equal(f.uploads.length, 0);
  assert.equal(f.loads, 0);
  assert.ok(f.transitions.some(([name, value]) => name === "adminTab" && value === "orders"));
});

test("receiving validates attached images before inventory mutation; no-image receiving still works", async () => {
  const receiveCode = compile(componentSource("async function receive(", "const ship ="));
  const mb = 1024 * 1024;
  const invalidSelections = [
    [file(), file(), file(), file()],
    [file("large.png", 5 * mb + 1)],
    [file("one.png", 4 * mb), file("two.png", 4 * mb + 1)],
    [file("invalid.txt", 100, "text/plain")],
  ];
  function fixture() {
    const mutations = [], uploads = [], notifications = [], overlays = [];
    let loads = 0;
    const receive = new Function("orderImageUploadError", "mutate", "uploadOrderFiles", "load", "setOverlay", "notify", `${receiveCode}; return receive;`)(
      orderImageUploadError,
      async (...args) => { mutations.push(args); },
      async (...args) => { uploads.push(args); },
      async () => { loads++; },
      value => { overlays.push(value); },
      value => { notifications.push(value); },
    );
    return { receive, mutations, uploads, notifications, overlays, get loads() { return loads; } };
  }
  for (const selection of invalidSelections) {
    const f = fixture();
    await f.receive("test-order", "A-01", selection);
    assert.equal(f.mutations.length, 0, "invalid attachments must not receive the order or update inventory");
    assert.equal(f.uploads.length, 0);
    assert.equal(f.loads, 0);
    assert.deepEqual(f.overlays, []);
    assert.deepEqual(f.notifications, [orderImageUploadError(selection)]);
  }
  const f = fixture();
  await f.receive("test-order", "A-01", []);
  assert.deepEqual(f.mutations, [["receive", { orderId: "test-order", location: "A-01" }]]);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.loads, 0);
  assert.deepEqual(f.overlays, [null]);
  assert.match(f.notifications[0], /库存已更新/);
});
