import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import ts from "typescript";
import { parseGrossProfitCents, validAccountingMonth } from "../lib/account-book.ts";

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const schema = {};
new Function("require", "exports", compile(await readFile(new URL("../db/schema.ts", import.meta.url), "utf8")))(require, schema);
const code = compile(await readFile(new URL("../app/api/account-book/route.ts", import.meta.url), "utf8"));
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = postgres(process.env.DATABASE_URL, { max: 1 });
const rollback = new Error("ROLLBACK_ACCOUNT_BOOK_TEST_FIXTURES");

try {
  await client.begin(async tx => {
    const userId = `account_book_test_${randomUUID()}`;
    await tx`INSERT INTO users (id, wechat_id, name, password_hash, role)
      VALUES (${userId}, ${userId}, '记账本集成测试', 'not-a-login-hash', 'admin')`;
    let year;
    do { year = String(randomInt(5000, 9000)); }
    while ((await tx`SELECT month FROM monthly_gross_profits WHERE month LIKE ${`${year}-%`} LIMIT 1`).length);
    const firstMonth = `${year}-01`, secondMonth = `${year}-02`;
    const database = scoped => drizzle(Object.assign(scoped, { options: client.options }), { schema });
    const bound = database(tx);
    let failAudit = false;
    const db = {
      select: bound.select.bind(bound),
      transaction: callback => tx.savepoint(async scoped => {
        const next = database(scoped);
        if (!failAudit) return callback(next);
        return callback({ insert(table) {
          if (table === schema.auditLogs) return { values: async () => { throw new Error("deliberate audit failure"); } };
          return next.insert(table);
        } });
      }),
    };
    const modules = {
      "@/db": { getDb: () => db }, "@/db/schema": schema,
      "@/lib/account-book": { parseGrossProfitCents, validAccountingMonth },
      "@/lib/auth": {
        assertSameOrigin() {}, requireAppUser: async () => ({ id: userId, role: "admin" }), requireAdmin() {},
        routeError: error => error instanceof Response ? error : Response.json({ error: "服务器内部错误" }, { status: 500 }),
      },
    };
    const route = {};
    new Function("require", "exports", code)(id => modules[id] ?? require(id), route);
    const save = (month, grossProfit, note = "") => route.POST(new Request("http://localhost/api/account-book", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ month, grossProfit, note }),
    }));

    assert.equal((await save(firstMonth, "734.29", "首次记录")).status, 200);
    const [original] = await tx`SELECT * FROM monthly_gross_profits WHERE month = ${firstMonth}`;
    assert.equal(original.gross_profit_cents, 73429);
    assert.equal(original.created_by, userId);
    assert.equal((await save(secondMonth, "-12.50", "独立月份")).status, 200);
    assert.equal((await save(firstMonth, "0", "更新记录")).status, 200);
    const rows = await tx`SELECT * FROM monthly_gross_profits WHERE month IN (${firstMonth}, ${secondMonth}) ORDER BY month`;
    assert.equal(rows.length, 2, "same-month upsert must not add another row");
    assert.deepEqual(rows.map(row => row.gross_profit_cents), [0, -1250]);
    assert.equal(String(rows[0].created_at), String(original.created_at));
    assert.equal(rows[0].created_by, original.created_by);
    assert.equal(rows[0].note, "更新记录");
    assert.ok(new Date(rows[0].updated_at) >= new Date(original.updated_at));
    const get = await route.GET(new Request("http://localhost/api/account-book"));
    assert.equal(get.status, 200);
    const result = (await get.json()).records.filter(row => [firstMonth, secondMonth].includes(row.month));
    assert.deepEqual(result.map(row => [row.month, row.grossProfit]), [[secondMonth, -12.5], [firstMonth, 0]]);
    const [audits] = await tx`SELECT count(*)::int AS total FROM audit_logs
      WHERE actor_id = ${userId} AND action = 'save_monthly_gross_profit'`;
    assert.equal(audits.total, 3);

    failAudit = true;
    assert.equal((await save(firstMonth, "999", "不可持久化")).status, 500);
    const [afterFailure] = await tx`SELECT * FROM monthly_gross_profits WHERE month = ${firstMonth}`;
    assert.equal(afterFailure.gross_profit_cents, 0);
    assert.equal(afterFailure.note, "更新记录", "failed audit must roll back the upsert on a real database");
    assert.equal((await save(`${year}-03`, "1")).status, 500);
    assert.equal((await tx`SELECT month FROM monthly_gross_profits WHERE month = ${`${year}-03`}`).length, 0);
    failAudit = false;

    await assert.rejects(tx.savepoint(scoped => scoped`INSERT INTO monthly_gross_profits (month, gross_profit_cents)
      VALUES (${firstMonth}, 100)`), error => error.code === "23505");
    for (const month of ["0000-01", `${year}-00`, `${year}-13`, `${year}-1`, `${year}-03\n`]) {
      await assert.rejects(tx.savepoint(scoped => scoped`INSERT INTO monthly_gross_profits (month, gross_profit_cents)
        VALUES (${month}, 100)`), error => error.code === "23514", month);
    }
    await assert.rejects(tx.savepoint(scoped => scoped`INSERT INTO monthly_gross_profits (month, gross_profit_cents)
      VALUES (${`${year}-03`}, 2147483648)`), error => error.code === "22003");
    await assert.rejects(tx.savepoint(scoped => scoped`INSERT INTO monthly_gross_profits (month, gross_profit_cents, note)
      VALUES (${`${year}-03`}, 0, ${"a".repeat(501)})`), error => error.code === "23514");
    // Isolate these foreign keys from audit_logs' existing restrictive actor FK.
    const removedUser = `account_book_fk_test_${randomUUID()}`;
    await tx`INSERT INTO users (id, wechat_id, name, password_hash, role)
      VALUES (${removedUser}, ${removedUser}, '记账外键测试', 'not-a-login-hash', 'admin')`;
    await tx`INSERT INTO monthly_gross_profits (month, gross_profit_cents, created_by, updated_by)
      VALUES (${`${year}-03`}, 10, ${removedUser}, ${removedUser})`;
    await tx`DELETE FROM users WHERE id = ${removedUser}`;
    const [foreignKeys] = await tx`SELECT created_by, updated_by, gross_profit_cents FROM monthly_gross_profits
      WHERE month = ${`${year}-03`}`;
    assert.equal(foreignKeys.created_by, null);
    assert.equal(foreignKeys.updated_by, null);
    assert.equal(foreignKeys.gross_profit_cents, 10, "deleting the test account keeps accounting history");
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
  console.log("Account book migration, real handler persistence/upserts, exact cents, month uniqueness, audit rollback and account deletion verified; fixtures rolled back.");
} finally {
  await client.end();
}
