import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, monthlyGrossProfits } from "@/db/schema";
import { parseGrossProfitCents, validAccountingMonth, type MonthlyGrossProfitRecord } from "@/lib/account-book";
import { assertSameOrigin, requireAdmin, requireAppUser, routeError } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function recordOf(row: typeof monthlyGrossProfits.$inferSelect): MonthlyGrossProfitRecord {
  return { month: row.month, grossProfit: row.grossProfitCents / 100, note: row.note, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export async function GET(request: Request) {
  try {
    requireAdmin(await requireAppUser(request));
    const rows = await getDb().select().from(monthlyGrossProfits).orderBy(desc(monthlyGrossProfits.month));
    return Response.json({ records: rows.map(recordOf) }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return routeError(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireAppUser(request);
    requireAdmin(user);
    let data: unknown;
    try { data = await request.json(); }
    catch { return Response.json({ error: "记账内容格式无效" }, { status: 400 }); }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return Response.json({ error: "记账内容格式无效" }, { status: 400 });
    }
    const body = data as Record<string, unknown>;
    if (!validAccountingMonth(body.month)) return Response.json({ error: "请选择有效月份，格式为 YYYY-MM" }, { status: 400 });
    const grossProfitCents = parseGrossProfitCents(body.grossProfit);
    if (grossProfitCents === null) {
      return Response.json({ error: "请输入有效毛利金额，支持正数、负数或零，最多两位小数" }, { status: 400 });
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      return Response.json({ error: "备注必须为文字，最多 500 字" }, { status: 400 });
    }
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > 500) return Response.json({ error: "备注最多 500 字" }, { status: 400 });
    const month = body.month;
    const now = new Date().toISOString();
    const record = await getDb().transaction(async tx => {
      const [saved] = await tx.insert(monthlyGrossProfits)
        .values({ month, grossProfitCents, note, createdBy: user.id, updatedBy: user.id, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: monthlyGrossProfits.month, set: { grossProfitCents, note, updatedBy: user.id, updatedAt: now } })
        .returning();
      const result = recordOf(saved);
      await tx.insert(auditLogs).values({
        id: `audit_${crypto.randomUUID()}`, actorId: user.id, action: "save_monthly_gross_profit", entityType: "monthly_gross_profit", entityId: month,
        detailJson: JSON.stringify({ after: result }), createdAt: now,
      });
      return result;
    });
    return Response.json({ record }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return routeError(error); }
}
