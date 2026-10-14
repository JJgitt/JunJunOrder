import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { parseGrossProfitCents, validAccountingMonth } from "../lib/account-book.ts";

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const schema = {};
new Function("require", "exports", compile(await readFile(new URL("../db/schema.ts", import.meta.url), "utf8")))(require, schema);
const routeCode = compile(await readFile(new URL("../app/api/account-book/route.ts", import.meta.url), "utf8"));
const admin = { id: "book-admin", role: "admin" };

function fixture({ user = admin, failAudit = false, crossOrigin = false } = {}) {
  let state = { records: [], audits: [] };
  const events = [];
  const insert = next => table => ({ values(value) {
    if (table === schema.auditLogs) {
      if (failAudit) return Promise.reject(new Error("audit unavailable"));
      next.audits.push(structuredClone(value));
      return Promise.resolve();
    }
    assert.equal(table, schema.monthlyGrossProfits);
    return { onConflictDoUpdate({ target, set }) {
      assert.equal(target, schema.monthlyGrossProfits.month);
      return { returning: async () => {
        const existing = next.records.find(row => row.month === value.month);
        if (existing) { Object.assign(existing, set); return [structuredClone(existing)]; }
        next.records.push(structuredClone(value));
        return [structuredClone(value)];
      } };
    } };
  } });
  const db = {
    select: () => ({ from(table) {
      assert.equal(table, schema.monthlyGrossProfits);
      return { orderBy: async () => structuredClone(state.records).sort((a, b) => b.month.localeCompare(a.month)) };
    } }),
    transaction: async callback => {
      events.push("transaction");
      const next = structuredClone(state);
      const result = await callback({ insert: insert(next) });
      state = next;
      return result;
    },
  };
  const modules = {
    "@/db": { getDb: () => { events.push("database"); return db; } },
    "@/db/schema": schema,
    "@/lib/account-book": { validAccountingMonth, parseGrossProfitCents },
    "@/lib/auth": {
      assertSameOrigin: () => { if (crossOrigin) throw Response.json({ error: "非法来源" }, { status: 403 }); },
      requireAppUser: async () => { if (!user) throw Response.json({ error: "请先登录" }, { status: 401 }); return user; },
      requireAdmin: person => { if (person.role !== "admin") throw Response.json({ error: "需要管理员权限" }, { status: 403 }); },
      routeError: error => error instanceof Response ? error : Response.json({ error: "服务器内部错误" }, { status: 500 }),
    },
  };
  const route = {};
  new Function("require", "exports", routeCode)(id => modules[id] ?? require(id), route);
  return {
    events, get state() { return state; },
    get: () => route.GET(new Request("http://localhost/api/account-book")),
    save: body => route.POST(new Request("http://localhost/api/account-book", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })),
    malformed: () => route.POST(new Request("http://localhost/api/account-book", { method: "POST", body: "{bad" })),
  };
}

test("accounting months require a real YYYY-MM month without year zero", () => {
  for (const month of ["2026-01", "2026-12", "0001-01", "9999-12"]) assert.equal(validAccountingMonth(month), true, month);
  for (const month of ["2026-0", "2026-00", "2026-13", "0000-01", "2026-1", "26-10", " 2026-10 ", "2026-10-01", null, 202610]) {
    assert.equal(validAccountingMonth(month), false, String(month));
  }
});

test("manual gross profit accepts exact positive, negative and zero cents without floating-point rounding", () => {
  for (const [amount, cents] of [["734.00", 73400], ["-12.34", -1234], ["0", 0], ["-.01", -1], ["+.50", 50], [" 001.20 ", 120], [0.29, 29], [-0.29, -29], ["21474836.47", 2147483647], ["-21474836.48", -2147483648]]) {
    assert.equal(parseGrossProfitCents(amount), cents, String(amount));
  }
  for (const amount of ["", "   ", "1.001", "-0.001", "21474836.48", "-21474836.49", "1e3", "NaN", "Infinity", "1,000", "--1", null, true, {}, [], NaN, Infinity]) {
    assert.equal(parseGrossProfitCents(amount), null, String(amount));
  }
});

test("account-book GET and POST block anonymous and buyer users before accessing the database", async () => {
  for (const [user, status] of [[null, 401], [{ id: "buyer", role: "buyer" }, 403]]) {
    const f = fixture({ user });
    assert.equal((await f.get()).status, status);
    assert.equal((await f.save({ month: "2026-10", grossProfit: "10" })).status, status);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.state, { records: [], audits: [] });
  }
  const f = fixture({ crossOrigin: true });
  assert.equal((await f.save({ month: "2026-10", grossProfit: "10" })).status, 403);
  assert.deepEqual(f.events, []);
});

test("saving distinct months persists independently; editing one month keeps one row and original creator fields", async () => {
  const f = fixture();
  const first = await f.save({ month: "2026-10", grossProfit: "734.29", note: "  十月核算  " });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const original = structuredClone(f.state.records[0]);
  assert.equal(original.grossProfitCents, 73429);
  assert.equal(original.createdBy, admin.id);
  const second = await f.save({ month: "2026-09", grossProfit: -50 });
  assert.equal(second.status, 200);
  assert.equal((await f.save({ month: "2026-10", grossProfit: "0", note: "复核后为零" })).status, 200);
  assert.equal(f.state.records.length, 2);
  const updated = f.state.records.find(row => row.month === "2026-10");
  assert.equal(updated.grossProfitCents, 0);
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(updated.createdBy, original.createdBy);
  assert.equal(updated.note, "复核后为零");
  const response = await f.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { records } = await response.json();
  assert.deepEqual(records.map(row => [row.month, row.grossProfit]), [["2026-10", 0], ["2026-09", -50]]);
  assert.equal(records[0].createdBy, undefined, "API returns presentation records, not internal account identifiers");
  assert.equal(f.state.audits.length, 3);
  assert.equal(f.state.audits[0].action, "save_monthly_gross_profit");
  assert.equal(f.state.audits[0].entityId, "2026-10");
  assert.equal(JSON.parse(f.state.audits[0].detailJson).after.grossProfit, 734.29);
});

test("account-book rejects invalid amounts, months, payloads and notes without writing anything", async () => {
  const invalid = [
    null, [], "text", {}, { month: "2026-13", grossProfit: "1" },
    ...["", " ", "1.001", "21474836.48", "-21474836.49", null, true, {}].map(grossProfit => ({ month: "2026-10", grossProfit })),
    { month: "2026-10", grossProfit: "1", note: 123 },
    { month: "2026-10", grossProfit: "1", note: "a".repeat(501) },
  ];
  for (const body of invalid) {
    const f = fixture();
    assert.equal((await f.save(body)).status, 400, JSON.stringify(body));
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.state, { records: [], audits: [] });
  }
  const f = fixture();
  assert.equal((await f.malformed()).status, 400);
  assert.deepEqual(f.events, []);
  assert.equal((await f.save({ month: "2026-10", grossProfit: "1", note: "a".repeat(500) })).status, 200);
});

test("an audit failure rolls back the monthly record in the same transaction", async () => {
  const f = fixture({ failAudit: true });
  assert.equal((await f.save({ month: "2026-10", grossProfit: "734", note: "测试" })).status, 500);
  assert.deepEqual(f.state, { records: [], audits: [] });
  assert.deepEqual((await (await f.get()).json()).records, []);
});
