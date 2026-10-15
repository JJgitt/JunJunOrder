import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/workspace-ui.css", import.meta.url), "utf8");
const compile = source => ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function sourceBetween(start, end) {
  const first = page.indexOf(start), last = page.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Expected component boundaries: ${start}, ${end}`);
  return page.slice(first, last);
}
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
  const states = [], refs = [];
  let stateIndex = 0, refIndex = 0;
  return {
    reset: () => { stateIndex = 0; refIndex = 0; },
    useState: initial => {
      const key = stateIndex++;
      if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial;
      return [states[key], value => { states[key] = typeof value === "function" ? value(states[key]) : value; }];
    },
    useRef: initial => {
      const key = refIndex++;
      return refs[key] ?? (refs[key] = { current: initial });
    },
  };
}
const order = {
  id: "order-test", platform: "淘宝", platformNo: "platform-test", amount: 200, title: "测试商品", itemCount: 1,
  purchaser: "采购员", status: "已发货", settled: true, images: [], settlementProofs: [],
  items: [{ id: "item-test", title: "测试商品", sku: "TEST-SKU", size: "M", qty: 2, amount: 200, shipped: true }],
};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const sheetCode = compile(sourceBetween("function RollbackShipmentSheet(", "function RejectSheet("));
const modalCode = compile(sourceBetween("function Modal(", "function AdminNav("));
const Modal = new Function("React", "useEffect", "createPortal", "document", "CopyNumber", `${modalCode}; return Modal;`)(
  React, () => {}, tree => tree, { body: {} }, "CopyNumber",
);
function fixture(submit = async () => {}) {
  const hook = hooks(), calls = [];
  let closed = 0;
  const Sheet = new Function("React", "useState", "useRef", "Modal", "orderTitleWithQuantity", "money", `${sheetCode}; return RollbackShipmentSheet;`)(
    React, hook.useState, hook.useRef, "Modal", value => value.title, amount => `¥${amount.toFixed(2)}`,
  );
  function render() {
    hook.reset();
    const tree = Sheet({ order, onClose: () => { closed++; }, onSubmit: async (...args) => { calls.push(args); await submit(...args); } });
    const all = nodes(tree), modal = Modal(tree.props);
    return {
      tree, all, modal,
      reason: all.find(node => node.type === "textarea"),
      save: all.find(node => node.type === "button" && node.props.className === "primary-button danger-button"),
      cancel: all.find(node => node.type === "button" && node.props.className === "secondary-button"),
      close: nodes(modal).find(node => node.type === "button" && node.props["aria-label"] === "关闭"),
      error: all.find(node => node.props.role === "alert"),
    };
  }
  return { render, calls, get closed() { return closed; } };
}

test("rollback confirmation explains destructive changes and cancellation never submits", () => {
  const f = fixture(), view = f.render();
  assert.equal(view.tree.props.subtitleCopyValue, order.id, "order number retains the shared copy control");
  for (const phrase of ["在途 · 未结款", "入库时间与库位", "发货物流", "发货时间", "二级平台信息与预估售价", "结款金额", "结款时间", "结款人", "订单图片保留", "结款截图归档留痕", "不会实际退款", "不会取消快递运单"]) {
    assert.ok(text(view.tree).includes(phrase), phrase);
  }
  assert.equal(view.reason.props.maxLength, 500);
  view.cancel.props.onClick();
  assert.equal(f.closed, 1);
  assert.equal(f.calls.length, 0);
});

test("rollback submits a trimmed optional reason only once and locks all exit and edit controls", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture(() => pending);
  f.render().reason.props.onChange({ target: { value: "  录入错误  " } });
  const stale = f.render();
  stale.save.props.onClick();
  stale.save.props.onClick();
  assert.deepEqual(f.calls, [[order.id, "录入错误"]]);
  const busy = f.render();
  for (const control of [busy.save, busy.cancel, busy.close, busy.reason]) assert.equal(control.props.disabled, true);
  busy.close.props.onClick();
  busy.cancel.props.onClick();
  stale.cancel.props.onClick();
  stale.reason.props.onChange({ target: { value: "不应覆盖" } });
  assert.equal(f.closed, 0);
  assert.equal(f.render().reason.props.value, "  录入错误  ");
  assert.match(text(busy.save), /正在回滚/);
  finish(); await nextTurn();
  assert.equal(f.render().save.props.disabled, false);
});

test("rollback failure preserves the reason and shows the server error for explicit retry", async () => {
  let attempt = 0;
  const f = fixture(async () => { if (++attempt === 1) throw new Error("订单状态已变化，请刷新后重试"); });
  f.render().reason.props.onChange({ target: { value: "保留原因" } });
  f.render().save.props.onClick(); await nextTurn();
  const failed = f.render();
  assert.equal(failed.reason.props.value, "保留原因");
  assert.match(text(failed.error), /订单状态已变化/);
  assert.equal(failed.save.props.disabled, false);
  assert.equal(f.closed, 0);
  failed.save.props.onClick(); await nextTurn();
  assert.equal(f.calls.length, 2);
  assert.equal(f.render().error, undefined);
});

test("empty rollback reasons are allowed but oversized programmatic values never submit", async () => {
  const f = fixture();
  f.render().save.props.onClick(); await nextTurn();
  assert.deepEqual(f.calls, [[order.id, ""]]);
  f.render().reason.props.onChange({ target: { value: "原".repeat(501) } });
  f.render().save.props.onClick(); await nextTurn();
  assert.equal(f.calls.length, 1);
  assert.match(text(f.render().error), /500/);
});

test("only administrators see the rollback entry on a fully shipped order", () => {
  const detailCode = compile(sourceBetween("function OrderDetail(", "function OrderImageUploadSheet("));
  const stubs = {
    React, Modal: "Modal", Badge: "Badge", KeyValue: "KeyValue", PurchaseCourierList: "PurchaseCourierList", TrackingPanel: "TrackingPanel",
    CopyNumber: "CopyNumber", CopyButton: "CopyButton", OrderImages: "OrderImages", useServerClock: () => ({ dateTime: value => value ?? "" }),
    postReceiptTimelineEvents: () => [], timestamp: () => 0, statusTone: {}, statusLabel: value => value,
    orderTitleWithQuantity: value => value.title, money: String, orderQuantity: () => 2, unitPrice: value => value.amount / value.qty,
    canRejectOrder: () => false, canSettleOrder: () => false, isSettlementStage: () => true,
    readyToShip: status => status === "已入库" || status === "待发货",
  };
  const Detail = new Function(...Object.keys(stubs), `${detailCode}; return OrderDetail;`)(...Object.values(stubs));
  for (const canManage of [false, true]) {
    for (const status of ["待审核", "在途", "待发货", "已入库", "已发货", "已驳回"]) {
      let opened = 0;
      const tree = Detail({ order: { ...order, status }, canManage, showLocation: canManage, onRollbackShipped: () => { opened++; } });
      const entry = nodes(tree).find(node => node.type === "button" && node.props.className === "rollback-shipped-entry");
      assert.equal(Boolean(entry), canManage && status === "已发货", `${canManage ? "admin" : "buyer"} ${status}`);
      if (entry) { entry.props.onClick(); assert.equal(opened, 1); }
    }
  }
});

test("successful rollback applies the normal mutation snapshot without resetting list filters or pagination", async () => {
  const handler = compile(sourceBetween("async function rollbackShippedOrder(", "async function resetPassword("));
  const mutations = [], overlays = [], notices = [];
  const rollback = new Function("mutate", "setOverlay", "notify", `${handler}; return rollbackShippedOrder;`)(
    async (...args) => { mutations.push(args); }, value => { overlays.push(value); }, value => { notices.push(value); },
  );
  await rollback(order.id, "修正录入");
  assert.deepEqual(mutations, [["rollback-shipped-order", { orderId: order.id, reason: "修正录入" }]]);
  assert.deepEqual(overlays, [null]);
  assert.match(notices[0], /在途、未结款/);
  assert.doesNotMatch(handler, /setAdminOrderListState|setBuyerOrderListState|setAdminTab|setBuyerTab|location\.reload|\bload\(/);
  const mutate = sourceBetween("async function mutate(", "async function refreshOrderData(");
  assert.match(mutate, /applySnapshot\(json\.data\)/);
  assert.match(page, /role === "admin" && overlay === "rollback-shipped" && selected && selected\.status === "已发货"/);
});

test("failed rollback requests do not close the confirmation or report success", async () => {
  const handler = compile(sourceBetween("async function rollbackShippedOrder(", "async function resetPassword("));
  let changed = 0;
  const rollback = new Function("mutate", "setOverlay", "notify", `${handler}; return rollbackShippedOrder;`)(
    async () => { throw new Error("回滚失败"); }, () => { changed++; }, () => { changed++; },
  );
  await assert.rejects(rollback(order.id, "保留原因"), /回滚失败/);
  assert.equal(changed, 0);
});

test("rollback uses readable touch targets and the existing Android-safe modal scroller", () => {
  assert.match(css, /\.rollback-shipped-entry\s*\{[^}]*min-height: 44px/);
  assert.match(css, /\.rollback-shipped-reason textarea\s*\{[^}]*font-size: 16px/);
  assert.match(css, /\.rollback-shipped-actions > button\s*\{[^}]*min-height: 48px/);
  assert.match(modalCode, /className: "modal-body"/);
  assert.match(modalCode, /disabled: closeDisabled/);
});
