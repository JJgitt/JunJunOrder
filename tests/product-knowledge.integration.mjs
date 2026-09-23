import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { matchProductKnowledge } from "../lib/product-knowledge-match.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = postgres(process.env.DATABASE_URL, { max: 1 });
const rollback = new Error("ROLLBACK_PRODUCT_KNOWLEDGE_TEST");
try {
  await db.begin(async tx => {
    const suffix = randomUUID().slice(0, 8);
    const title = `维秘波点长袖睡衣${suffix}`;
    const historical = `维秘波点短袖睡衣${suffix}`;
    const manualId = `pk_test_${randomUUID()}`;
    const historicalId = `pk_test_${randomUUID()}`;
    await tx`INSERT INTO product_knowledge (id,title,sku,aliases,source)
      VALUES (${manualId},${title},${`VS-${suffix}`},${JSON.stringify([`波点长袖${suffix}`])},'manual')`;
    await tx`INSERT INTO product_knowledge (id,title,sku,aliases,source)
      VALUES (${historicalId},${historical},${`VS-S-${suffix}`},'[]','historical')`;
    const rows = await tx`SELECT id,title,sku,aliases,source FROM product_knowledge WHERE id IN (${manualId},${historicalId})`;
    const products = rows.map(row => ({ ...row, aliases: JSON.parse(row.aliases) }));
    assert.equal(matchProductKnowledge({ title, sku: title, skuSource: "title" }, products).kind, "auto");
    assert.equal(matchProductKnowledge({ title: historical, sku: historical, skuSource: "title" }, products).kind, "suggestion");
    await assert.rejects(tx.savepoint(() => tx`INSERT INTO product_knowledge (id,title,sku,source)
      VALUES (${`pk_test_${randomUUID()}`},${title},${`VS-${suffix}`},'manual')`), error => error.code === "23505");
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
  console.log("Product knowledge migration, source rules and uniqueness verified; fixtures rolled back.");
} finally {
  await db.end();
}
