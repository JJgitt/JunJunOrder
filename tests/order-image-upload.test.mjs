import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const routeCode = compile(await readFile(new URL("../app/api/order-images/route.ts", import.meta.url), "utf8"));
const validation = {};
new Function("exports", compile(await readFile(new URL("../lib/order-image-upload.ts", import.meta.url), "utf8")))(validation);
const { orderImageUploadError } = validation;
const MB = 1024 * 1024;
const admin = { id: "admin", name: "管理员", role: "admin" };
const buyer = { id: "buyer", name: "采购员", role: "buyer" };
const otherBuyer = { id: "other-buyer", name: "其他采购员", role: "buyer" };
const storedTime = "2026-10-11T08:30:00.123Z";
const image = (name = "order.png", type = "image/png", content = "test-image") => new File([content], name, { type });

function fixture(options = {}) {
  const tables = Object.fromEntries(["purchaseOrders", "orderImages", "auditLogs"].map(name => [name, new Proxy({ name }, {
    get(target, key) { return key === "name" ? target.name : { table: name, key }; },
  })]));
  let state = {
    purchaseOrders: options.missingOrder ? [] : [{ id: "order-1", purchaserId: buyer.id, status: "已入库", settled: true, settledAmountCents: 12300, ...options.order }],
    orderImages: [{ id: "old-image", orderId: "order-1", kind: "order", objectKey: "orders/order-1/old.png", fileName: "old.png", createdAt: "2026-10-10T01:00:00Z", uploadedBy: buyer.id }],
    auditLogs: [],
  };
  const files = new Map([["/uploads/orders/order-1/old.png", "old-content"]]);
  const operations = [];
  let openCount = 0, writeCount = 0;
  const query = getState => ({
    select: projection => ({ from(table) {
      let predicate = () => true, limit = Infinity;
      const builder = {
        where(value) { predicate = value; return builder; },
        for(value) { operations.push({ action: "lock", mode: value }); return builder; },
        limit(value) { limit = value; return builder; },
        then(resolve, reject) {
          const rows = getState()[table.name].filter(predicate).slice(0, limit).map(row => projection
            ? Object.fromEntries(Object.entries(projection).map(([key, column]) => [key, row[column.key]]))
            : structuredClone(row));
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return builder;
    } }),
    insert: table => ({ values(value) {
      operations.push({ action: "insert", table: table.name });
      if (options.failInsert === table.name) throw new Error("simulated database insert failure");
      const rows = (Array.isArray(value) ? value : [value]).map(row => ({ ...structuredClone(row), createdAt: storedTime }));
      getState()[table.name].push(...rows);
      return {
        returning: projection => Promise.resolve(rows.map(row => Object.fromEntries(Object.entries(projection).map(([key, column]) => [key, row[column.key]])))),
        then(resolve, reject) { return Promise.resolve().then(resolve, reject); },
      };
    } }),
  });
  const db = {
    ...query(() => state),
    async transaction(callback) {
      if (options.beforeLock) options.beforeLock(state);
      const next = structuredClone(state);
      const result = await callback(query(() => next));
      if (options.failCommit) throw new Error("simulated commit failure");
      state = next;
      return result;
    },
  };
  const modules = {
    "@/db": { getDb: () => db }, "@/db/schema": tables,
    "drizzle-orm": { eq: (column, value) => row => row[column.key] === value, and: (...predicates) => row => predicates.every(predicate => predicate(row)) },
    "@/lib/auth": {
      assertSameOrigin: request => {
        if (request.headers.get("origin") && request.headers.get("origin") !== "http://localhost") throw Response.json({ error: "请求来源无效" }, { status: 403 });
      },
      requireAppUser: async () => {
        if (options.actor === null) throw Response.json({ error: "请先登录" }, { status: 401 });
        return options.actor ?? admin;
      },
      routeError: error => error instanceof Response ? error : Response.json({ error: error.message }, { status: 500 }),
    },
    "@/lib/order-image-upload": validation,
    "@/lib/file-storage": {
      imageExtension: type => ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/heic": ".heic", "image/heif": ".heif" })[type] ?? null,
      uploadPath: key => `/uploads/${key}`,
    },
    "node:fs/promises": {
      mkdir: async () => { operations.push({ action: "mkdir" }); },
      open: async (path, mode) => {
        operations.push({ action: "open", path, mode });
        if (++openCount === options.failOpenAt) throw Object.assign(new Error("simulated exclusive open failure"), { code: "EEXIST" });
        assert.equal(mode, "wx");
        assert.equal(files.has(path), false, "existing files must never be overwritten");
        files.set(path, Buffer.alloc(0));
        return {
          writeFile: async content => {
            operations.push({ action: "write", path });
            files.set(path, content);
            if (++writeCount === options.failWriteAt) throw new Error("simulated partial write failure");
          },
          close: async () => { operations.push({ action: "close", path }); },
        };
      },
      unlink: async path => { operations.push({ action: "unlink", path }); files.delete(path); },
    },
  };
  const route = {};
  new Function("require", "exports", routeCode)(id => modules[id] ?? require(id), route);
  return {
    files, operations, get state() { return state; },
    upload: async ({ orderId = "order-1", images = [image()], origin } = {}) => {
      const form = new FormData();
      if (orderId !== null) form.set("orderId", orderId);
      for (const file of images) form.append("files", file);
      return route.POST(new Request("http://localhost/api/order-images", { method: "POST", body: form, headers: origin ? { origin } : undefined }));
    },
  };
}

test("order-image validation accepts all six supported formats and exact size limits", () => {
  for (const type of ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]) {
    assert.equal(orderImageUploadError([{ type, size: 1 }]), null, type);
  }
  assert.equal(orderImageUploadError([{ type: "image/png", size: 5 * MB }]), null);
  assert.equal(orderImageUploadError([{ type: "image/png", size: 5 * MB }, { type: "image/jpeg", size: 3 * MB }]), null);
  assert.equal(orderImageUploadError(Array.from({ length: 3 }, () => ({ type: "image/png", size: 1 }))), null);
});

test("order-image validation rejects empty, over-count, invalid, per-file and aggregate sizes", () => {
  assert.match(orderImageUploadError([]), /请选择/);
  assert.match(orderImageUploadError(Array.from({ length: 4 }, () => ({ type: "image/png", size: 1 }))), /最多.*3/);
  assert.match(orderImageUploadError([{ type: "text/html", size: 1 }]), /仅支持/);
  for (const size of [0, -1, NaN, Infinity, 0.5]) assert.match(orderImageUploadError([{ type: "image/png", size }]), /不能为空/);
  assert.match(orderImageUploadError([{ type: "image/png", size: 5 * MB + 1 }]), /5MB/);
  assert.match(orderImageUploadError([{ type: "image/png", size: 5 * MB }, { type: "image/png", size: 3 * MB + 1 }]), /总大小.*8MB/);
});

test("administrators and the owning buyer may append screenshots in every workflow state", async () => {
  for (const actor of [admin, buyer]) {
    for (const status of ["待审核", "在途", "已入库", "已驳回"]) {
      const f = fixture({ actor, order: { status, settled: status === "已入库" } });
      const before = structuredClone(f.state.purchaseOrders);
      const response = await f.upload();
      assert.equal(response.status, 201, `${actor.role}/${status}`);
      const result = await response.json();
      assert.equal(result.imageIds.length, 1);
      assert.deepEqual(result.images, [{ id: result.imageIds[0], fileName: "order.png", createdAt: storedTime, url: `/api/files/${result.imageIds[0]}`, uploadedBy: actor.name }]);
      assert.deepEqual(f.state.purchaseOrders, before, "attachments must not modify status, settlement or purchaser");
      assert.equal(f.state.orderImages[1].uploadedBy, actor.id);
      assert.equal(f.state.orderImages[1].kind, "order");
      assert.equal(f.state.auditLogs[0].actorId, actor.id);
      assert.equal(f.state.auditLogs[0].action, "append_order_images");
      assert.deepEqual(JSON.parse(f.state.auditLogs[0].detailJson), { imageIds: result.imageIds, count: 1 });
    }
  }
});

test("multi-image append preserves all prior screenshots and uses one atomic metadata insert", async () => {
  const f = fixture({ actor: buyer });
  const oldImage = structuredClone(f.state.orderImages[0]);
  const response = await f.upload({ images: [image("first.png"), image("second.jpg", "image/jpeg"), image("third.heif", "image/heif")] });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.images.length, 3);
  assert.equal(f.state.orderImages.length, 4);
  assert.deepEqual(f.state.orderImages[0], oldImage);
  assert.equal(f.files.get("/uploads/orders/order-1/old.png"), "old-content");
  assert.equal(f.operations.filter(op => op.action === "insert" && op.table === "orderImages").length, 1);
  assert.equal(f.operations.some(op => op.action === "unlink"), false);
  assert.ok(f.operations.findIndex(op => op.action === "lock") < f.operations.findIndex(op => op.action === "open"));
  assert.equal((await f.upload()).status, 201, "repeated appends add files instead of replacing earlier uploads");
  assert.equal(f.state.orderImages.length, 5);
});

test("anonymous, non-owning buyers, missing orders and missing IDs never write files", async () => {
  for (const [options, request, status] of [
    [{ actor: null }, {}, 401],
    [{ actor: otherBuyer }, {}, 403],
    [{ missingOrder: true }, {}, 404],
    [{}, { orderId: null }, 400],
    [{}, { orderId: "  " }, 400],
    [{}, { origin: "https://attacker.invalid" }, 403],
  ]) {
    const f = fixture(options);
    assert.equal((await f.upload(request)).status, status);
    assert.equal(f.operations.length, 0);
    assert.equal(f.files.size, 1);
  }
});

test("all upload validation completes before disk writes, with no silent truncation", async () => {
  for (const images of [
    [], [image(), image("wrong.html", "text/html")], [image(), image("empty.png", "image/png", "")],
    Array.from({ length: 4 }, () => image()), [image(), "not-a-file"],
    [image("huge.png", "image/png", Buffer.alloc(5 * MB + 1))],
    [image("first.png", "image/png", Buffer.alloc(4 * MB + 1)), image("second.png", "image/png", Buffer.alloc(4 * MB))],
  ]) {
    const f = fixture();
    assert.equal((await f.upload({ images })).status, 400);
    assert.equal(f.operations.length, 0, "even a valid first file cannot be persisted when later files fail validation");
    assert.equal(f.state.orderImages.length, 1);
    assert.equal(f.files.size, 1);
  }
});

test("ownership and existence are revalidated under lock before writing", async () => {
  for (const [beforeLock, status] of [
    [state => { state.purchaseOrders[0].purchaserId = otherBuyer.id; }, 403],
    [state => { state.purchaseOrders = []; }, 404],
  ]) {
    const f = fixture({ actor: buyer, beforeLock });
    assert.equal((await f.upload()).status, status);
    assert.deepEqual(f.operations, [{ action: "lock", mode: "update" }]);
    assert.equal(f.files.size, 1);
    assert.equal(f.state.orderImages.length, 1);
  }
});

test("database insert, audit and commit failures roll back all metadata and clean only new files", async () => {
  for (const options of [{ failInsert: "orderImages" }, { failInsert: "auditLogs" }, { failCommit: true }]) {
    const f = fixture(options), before = structuredClone(f.state);
    assert.equal((await f.upload({ images: [image("first.png"), image("second.png")] })).status, 500);
    assert.deepEqual(f.state, before);
    assert.deepEqual([...f.files], [["/uploads/orders/order-1/old.png", "old-content"]]);
    assert.equal(f.operations.filter(op => op.action === "unlink").length, 2);
    assert.equal(f.operations.some(op => op.action === "unlink" && op.path.endsWith("old.png")), false);
  }
});

test("exclusive-open failure leaves preexisting files intact and removes preceding new writes", async () => {
  const f = fixture({ failOpenAt: 2 }), before = structuredClone(f.state);
  assert.equal((await f.upload({ images: [image("first.png"), image("second.png")] })).status, 500);
  assert.deepEqual(f.state, before);
  assert.deepEqual([...f.files], [["/uploads/orders/order-1/old.png", "old-content"]]);
  assert.equal(f.operations.filter(op => op.action === "unlink").length, 1, "a target that failed exclusive creation is not owned and must not be removed");
});

test("a partial write failure closes the handle and cleans the failed file and preceding files", async () => {
  const f = fixture({ failWriteAt: 2 }), before = structuredClone(f.state);
  assert.equal((await f.upload({ images: [image("first.png"), image("second.png")] })).status, 500);
  assert.deepEqual(f.state, before);
  assert.deepEqual([...f.files], [["/uploads/orders/order-1/old.png", "old-content"]]);
  assert.equal(f.operations.filter(op => op.action === "close").length, 2);
  assert.equal(f.operations.filter(op => op.action === "unlink").length, 2);
  assert.equal(f.operations.some(op => op.action === "insert"), false);
});
