import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, productKnowledge } from "@/db/schema";
import { assertSameOrigin, requireAdmin, requireAppUser, routeError } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const aliasesOf = (text: string): string[] => {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
};

export async function GET(request: Request) {
  try {
    const user = await requireAppUser(request);
    requireAdmin(user);
    const rows = await getDb().select().from(productKnowledge).orderBy(desc(productKnowledge.updatedAt));
    return Response.json({ products: rows.map(row => ({ ...row, aliases: aliasesOf(row.aliases) })) }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return routeError(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireAppUser(request);
    requireAdmin(user);
    const body = await request.json() as Record<string, unknown>;
    const action = string(body.action);
    const db = getDb();
    if (action === "save") {
      const id = string(body.id);
      const title = string(body.title), sku = string(body.sku);
      if (!title || title.length > 200 || !sku || sku.length > 100) {
        return Response.json({ error: "商品名称和货号均需填写，且不得超过长度限制" }, { status: 400 });
      }
      if (!Array.isArray(body.aliases) || body.aliases.length > 10 || body.aliases.some(value => typeof value !== "string" || value.trim().length > 100)) {
        return Response.json({ error: "别名最多 10 个，每个不超过 100 字" }, { status: 400 });
      }
      const aliases = [...new Set((body.aliases as string[]).map(alias => alias.trim()).filter(alias => alias && alias !== title))];
      const [duplicate] = await db.select({ id: productKnowledge.id }).from(productKnowledge)
        .where(and(eq(productKnowledge.title, title), eq(productKnowledge.sku, sku), ...(id ? [ne(productKnowledge.id, id)] : []))).limit(1);
      if (duplicate) return Response.json({ error: "该商品名称与货号已存在" }, { status: 409 });
      const now = new Date().toISOString();
      const saved = await db.transaction(async tx => {
        if (id) {
          const [before] = await tx.select().from(productKnowledge).where(eq(productKnowledge.id, id)).for("update").limit(1);
          if (!before) return null;
          await tx.update(productKnowledge).set({ title, sku, aliases: JSON.stringify(aliases), source: "manual", updatedAt: now }).where(eq(productKnowledge.id, id));
          await tx.insert(auditLogs).values({ id: `audit_${crypto.randomUUID()}`, actorId: user.id, action: "update_product_knowledge", entityType: "product_knowledge", entityId: id, detailJson: JSON.stringify({ before: { title: before.title, sku: before.sku, aliases: aliasesOf(before.aliases) }, after: { title, sku, aliases } }), createdAt: now });
          return id;
        }
        const newId = `pk_${crypto.randomUUID()}`;
        await tx.insert(productKnowledge).values({ id: newId, title, sku, aliases: JSON.stringify(aliases), source: "manual", createdAt: now, updatedAt: now });
        await tx.insert(auditLogs).values({ id: `audit_${crypto.randomUUID()}`, actorId: user.id, action: "create_product_knowledge", entityType: "product_knowledge", entityId: newId, detailJson: JSON.stringify({ title, sku, aliases }), createdAt: now });
        return newId;
      });
      return saved ? Response.json({ id: saved }) : Response.json({ error: "商品资料不存在" }, { status: 404 });
    }
    if (action === "delete") {
      const id = string(body.id);
      if (!id) return Response.json({ error: "请选择要删除的商品资料" }, { status: 400 });
      const removed = await db.transaction(async tx => {
        const [before] = await tx.delete(productKnowledge).where(eq(productKnowledge.id, id)).returning({ id: productKnowledge.id, title: productKnowledge.title, sku: productKnowledge.sku });
        if (!before) return false;
        await tx.insert(auditLogs).values({ id: `audit_${crypto.randomUUID()}`, actorId: user.id, action: "delete_product_knowledge", entityType: "product_knowledge", entityId: id, detailJson: JSON.stringify({ title: before.title, sku: before.sku }), createdAt: new Date().toISOString() });
        return true;
      });
      return removed ? Response.json({ deleted: true }) : Response.json({ error: "商品资料不存在" }, { status: 404 });
    }
    return Response.json({ error: "未知操作" }, { status: 400 });
  } catch (error) {
    const databaseError = error as { code?: string; cause?: { code?: string } };
    if ((databaseError.code ?? databaseError.cause?.code) === "23505") return Response.json({ error: "该商品名称与货号已存在" }, { status: 409 });
    return routeError(error);
  }
}
