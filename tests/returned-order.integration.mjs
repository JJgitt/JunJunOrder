import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const url = new URL(process.env.DATABASE_URL);
if (!/test|ci/i.test(url.pathname)) throw new Error("Returned-order migration integration requires a dedicated test/CI database");
const client = postgres(process.env.DATABASE_URL, { max: 1, connection: { statement_timeout: 10000, lock_timeout: 10000 } });
const migration = await readFile(new URL("../drizzle/0018_returned_order_flag.sql", import.meta.url), "utf8");
const backfillStart = migration.indexOf('UPDATE "purchase_orders"');
assert.ok(backfillStart >= 0, "the real migration must contain the historical return backfill");
const backfill = migration.slice(backfillStart);
const marker = `returned_test_${randomUUID().replaceAll("-", "")}`;
const rollback = new Error("ROLLBACK_RETURNED_ORDER_MIGRATION_FIXTURES");

try {
  try {
    await client.begin(async tx => {
      // Reproduce a database at 0017 without changing any applied migration file.
      // DDL, fixtures and backfill all live in this savepoint and are rolled back.
      await tx.savepoint(async scoped => {
        await scoped`ALTER TABLE purchase_orders DROP COLUMN is_returned`;
        await scoped`INSERT INTO users (id,wechat_id,name,password_hash,role)
          VALUES (${marker},${marker},'回流迁移测试','not-a-login-hash','admin')`;
        const fixtures = [
          { key: "transit", status: "在途", returned: true, audits: [["rollback_shipped_order", "purchase_order"]] },
          { key: "reentered", status: "已入库", returned: true, audits: [["rollback_shipped_order", "purchase_order"], ["rollback_shipped_order", "purchase_order"]] },
          { key: "wrong_type", status: "在途", returned: false, audits: [["rollback_shipped_order", "user"]] },
          { key: "receipt_only", status: "在途", returned: false, audits: [["revert_receive", "purchase_order"]] },
          { key: "no_audit", status: "已入库", returned: false, audits: [] },
          { key: "wrong_action", status: "在途", returned: false, audits: [["rollback-shipped-order", "purchase_order"]] },
        ];
        const stamp = "2025-01-02T03:04:05.000Z";
        for (const fixture of fixtures) {
          fixture.id = `${marker}_${fixture.key}`;
          await scoped`INSERT INTO purchase_orders (id,platform,platform_order_no,purchaser_id,status,created_at,updated_at)
            VALUES (${fixture.id},'淘宝',${fixture.id},${marker},${fixture.status},${stamp},${stamp})`;
          for (const [index, [action, entityType]] of fixture.audits.entries()) {
            await scoped`INSERT INTO audit_logs (id,actor_id,action,entity_type,entity_id)
              VALUES (${`${fixture.id}_audit_${index}`},${marker},${action},${entityType},${fixture.id})`;
          }
        }
        await scoped`INSERT INTO audit_logs (id,actor_id,action,entity_type,entity_id)
          VALUES (${`${marker}_nonexistent`},${marker},'rollback_shipped_order','purchase_order',${`${marker}_missing`})`;
        const before = await scoped`SELECT to_jsonb(p) AS row FROM purchase_orders p WHERE purchaser_id=${marker} ORDER BY id`;

        await scoped.unsafe(migration);

        const [column] = await scoped`SELECT data_type,is_nullable,column_default FROM information_schema.columns
          WHERE table_schema=current_schema() AND table_name='purchase_orders' AND column_name='is_returned'`;
        assert.equal(column.data_type, "boolean"); assert.equal(column.is_nullable, "NO"); assert.match(column.column_default, /false/);
        const [comment] = await scoped`SELECT col_description('purchase_orders'::regclass,attnum) AS value FROM pg_attribute
          WHERE attrelid='purchase_orders'::regclass AND attname='is_returned'`;
        assert.match(comment.value, /回流/);
        const rows = await scoped`SELECT id,is_returned FROM purchase_orders WHERE purchaser_id=${marker} ORDER BY id`;
        assert.equal(rows.length, fixtures.length, "multiple rollback audits must not duplicate orders");
        for (const fixture of fixtures) assert.equal(rows.find(row => row.id === fixture.id).is_returned, fixture.returned, fixture.key);
        assert.deepEqual(await scoped`SELECT to_jsonb(p)-'is_returned' AS row FROM purchase_orders p WHERE purchaser_id=${marker} ORDER BY id`, before,
          "migration must preserve status, original timestamps and all other business columns");

        await scoped.unsafe(backfill);
        assert.deepEqual(await scoped`SELECT id,is_returned FROM purchase_orders WHERE purchaser_id=${marker} ORDER BY id`, rows,
          "replaying historical backfill is idempotent");
        await scoped`INSERT INTO purchase_orders (id,platform,platform_order_no,purchaser_id,status)
          VALUES (${`${marker}_fresh`},'淘宝',${`${marker}_fresh`},${marker},'待审核')`;
        assert.equal((await scoped`SELECT is_returned FROM purchase_orders WHERE id=${`${marker}_fresh`}`)[0].is_returned, false,
          "new orders default to ordinary history after migration");
        throw rollback;
      });
    });
  } catch (error) { if (error !== rollback) throw error; }
  assert.equal((await client`SELECT count(*)::int AS count FROM users WHERE id=${marker}`)[0].count, 0, "migration test fixtures were rolled back");
  assert.equal((await client`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='purchase_orders' AND column_name='is_returned'`)[0].count, 1, "the previously bootstrapped column was restored after DDL rollback");
  console.log("Returned-order real migration defaults, exact historical audit backfill, duplicate audit handling, unchanged lifecycle/timestamps and transactional DDL rollback verified; fixtures removed.");
} finally { await client.end(); }
