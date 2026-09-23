import { assertSameOrigin, requireAppUser, routeError } from "@/lib/auth";
import { getDb } from "@/db";
import { sql } from "drizzle-orm";
import { productKnowledge } from "@/db/schema";
import { matchProductKnowledge, type KnowledgeMatch } from "@/lib/product-knowledge-match";
import { isVisionTimeout, recognizeOrderImages, visionConfigured } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function collectImages(form: FormData) {
  return [...form.getAll("images"), ...form.getAll("image")].filter((value): value is File => value instanceof File && value.type.startsWith("image/")).slice(0, 3);
}

/** 上传最多 3 张订单截图，返回可直接填入采购订单表单的识别结果草稿。采购员与管理员都可使用。 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireAppUser(request);
    if (!visionConfigured()) return Response.json({ error: "尚未配置智能识图服务，请手动填写订单信息" }, { status: 501 });
    const files = collectImages(await request.formData());
    if (!files.length) return Response.json({ error: "请选择订单截图" }, { status: 400 });
    if (files.some(file => file.size > 8 * 1024 * 1024)) return Response.json({ error: "请选择 8MB 以内的订单截图" }, { status: 400 });
    const started = Date.now();
    let data: Awaited<ReturnType<typeof recognizeOrderImages>>;
    try {
      data = await recognizeOrderImages(files);
    } catch (error) {
      if (isVisionTimeout(error)) {
        console.warn("[vision] upstream timeout", error);
        return Response.json({ error: "识图服务响应超时，请稍后重试，或手动填写订单信息" }, { status: 504 });
      }
      throw error;
    }
    console.info(`[vision] user=${user.id} images=${files.length} items=${data.items.length} platform=${data.platform || "-"} orderNo=${data.platformNo || "-"} in ${Date.now() - started}ms`);
    if (!data.platform && !data.platformNo && !data.items.length && !data.courierCompany && !data.courierNo) return Response.json({ error: "没有从截图里识别到订单信息，请换更清晰的订单详情截图" }, { status: 422 });
    let knowledgeMatches: KnowledgeMatch[] = [];
    let notes = data.notes;
    if (data.items.length) {
      const knowledgeStarted = Date.now();
      console.info(`[vision] product knowledge lookup started items=${data.items.length}`);
      try {
        // Match against the complete catalog: truncation can hide competitors and cause false auto-fills.
        // Bound the SQL statement and keep the recognized fields when catalog lookup fails.
        const rows = await getDb().transaction(async tx => {
          await tx.execute(sql`set local statement_timeout = '5000ms'`);
          return tx.select().from(productKnowledge);
        });
        const products = rows.map(row => {
          let aliases: string[] = [];
          try {
            const parsed: unknown = JSON.parse(row.aliases);
            if (Array.isArray(parsed)) aliases = parsed.filter((alias): alias is string => typeof alias === "string");
          } catch { /* Malformed legacy aliases do not break order recognition. */ }
          return { id: row.id, title: row.title, sku: row.sku, source: row.source, aliases };
        });
        knowledgeMatches = data.items.map(item => matchProductKnowledge(item, products));
        console.info(`[vision] product knowledge matched items=${data.items.length} products=${rows.length} in ${Date.now() - knowledgeStarted}ms`);
      } catch (error) {
        console.error(`[vision] product knowledge unavailable after ${Date.now() - knowledgeStarted}ms`, error);
        notes = [...notes, "商品资料匹配暂不可用，已保留识图结果，请人工核对商品名称和货号。"];
      }
    }
    return Response.json({ data: { ...data, notes, knowledgeMatches } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && /识图服务|JSON|模型/.test(error.message)) return Response.json({ error: error.message }, { status: 502 });
    return routeError(error);
  }
}
