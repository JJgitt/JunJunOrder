import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { prepareSettlementProof } from "../lib/settlement-proof-upload.ts";

const require = createRequire(import.meta.url);
const { NextRequest } = require("next/server");
const source = await readFile(new URL("../app/api/settlements/recognize/route.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(24).fill(0)]);
const pngFile = (type = "image/png", name = "proof.png") => new File([pngBytes], name, { type });

// Encode and parse real multipart bytes, rather than handing the route an in-memory FormData double.
async function multipartRequest(image, { explicitFilename = false } = {}) {
  const form = new FormData();
  if (image !== undefined) {
    if (explicitFilename) form.set("image", image, image.name);
    else form.set("image", image);
  }
  const outgoing = new NextRequest("http://localhost/api/settlements/recognize", { method: "POST", body: form });
  return new NextRequest(outgoing.url, { method: "POST", headers: outgoing.headers, body: await outgoing.arrayBuffer() });
}

function fixture({ role = "admin", configured = true } = {}) {
  const recognized = [], logs = [];
  const modules = {
    "@/lib/auth": {
      assertSameOrigin: () => {},
      requireAppUser: async () => {
        if (!role) throw new Response(null, { status: 401 });
        return { id: "test-admin", role };
      },
      requireAdmin: user => { if (user.role !== "admin") throw new Response(null, { status: 403 }); },
      routeError: error => error instanceof Response ? error : Response.json({ error: error.message }, { status: 500 }),
    },
    "@/lib/vision": {
      visionConfigured: () => configured,
      recognizeSettlementImage: async file => { recognized.push(file); return { amount: 258.5 }; },
    },
    "@/lib/settlement-proof-upload": { prepareSettlementProof },
  };
  const exports = {};
  new Function("require", "exports", "console", code)(id => {
    assert.ok(id in modules, `unexpected route dependency: ${id}`);
    return modules[id];
  }, exports, { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) });
  return { recognized, logs, post: exports.POST };
}

for (const type of ["image/png", "", "application/octet-stream"]) {
  test(`settlement recognition parses and normalizes ${type || "missing MIME"} multipart image`, async () => {
    const f = fixture();
    const response = await f.post(await multipartRequest(pngFile(type)));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { amount: 258.5 } });
    assert.equal(f.recognized.length, 1);
    assert.equal(f.recognized[0].type, "image/png");
    assert.equal(f.recognized[0].name, "proof.png");
    assert.deepEqual(new Uint8Array(await f.recognized[0].arrayBuffer()), pngBytes);
  });
}

test("an empty filename is parsed as a text field and gets a missing-file error instead of a size error", async () => {
  const request = await multipartRequest(pngFile("image/png", ""));
  const parsed = (await request.clone().formData()).get("image");
  assert.equal(typeof parsed, "string", "reproduce multipart losing the empty-named file brand");
  const f = fixture();
  const response = await f.post(request);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /未收到结款截图文件/);
  assert.equal(f.recognized.length, 0);
});

test("normalizing blank filenames preserves File through multipart and reaches the model", async () => {
  for (const name of ["", "   "]) {
    for (const type of ["image/png", ""]) {
      const prepared = await prepareSettlementProof(pngFile(type, name));
      assert.equal(prepared.name, "settlement-proof.png");
      const request = await multipartRequest(prepared, { explicitFilename: true });
      const parsed = (await request.clone().formData()).get("image");
      assert.ok(parsed instanceof File);
      assert.equal(parsed.name, "settlement-proof.png");
      const f = fixture();
      assert.equal((await f.post(request)).status, 200);
      assert.equal(f.recognized.length, 1);
    }
  }
});

test("invalid multipart uploads return distinct useful errors without invoking vision", async () => {
  for (const [image, expected] of [
    [undefined, /未收到结款截图文件/],
    ["not-a-file", /未收到结款截图文件/],
    [new File([], "empty.png", { type: "image/png" }), /空文件/],
    [new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }), /超过 5MB/],
    [new File(["not-an-image"], "unknown.png"), /未能确认图片格式/],
  ]) {
    const f = fixture();
    const response = await f.post(await multipartRequest(image));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, expected);
    assert.equal(f.recognized.length, 0);
  }
});

test("settlement recognition still requires an administrator and configured vision", async () => {
  for (const [options, status] of [
    [{ role: null }, 401],
    [{ role: "buyer" }, 403],
    [{ configured: false }, 501],
  ]) {
    const f = fixture(options);
    const response = await f.post(await multipartRequest(pngFile()));
    assert.equal(response.status, status);
    assert.equal(f.recognized.length, 0);
  }
});
