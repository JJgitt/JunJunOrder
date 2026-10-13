import { assertSameOrigin, requireAdmin, requireAppUser, routeError } from "@/lib/auth";
import { recognizeSettlementImage, visionConfigured } from "@/lib/vision";
import { prepareSettlementProof } from "@/lib/settlement-proof-upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireAppUser(request);
    requireAdmin(user);
    if (!visionConfigured()) return Response.json({ error: "尚未配置智能识图服务，请手动输入结款金额" }, { status: 501 });
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Response.json({ error: "无法读取结款截图，请重新选择图片后重试" }, { status: 400 });
    }
    const entry = form.get("image");
    // FormData may use a different File constructor; non-string entries are uploaded files.
    if (!entry || typeof entry === "string") {
      console.warn("[vision] settlement upload rejected: missing file", {fieldKind: entry == null ? "missing" : "text"});
      return Response.json({ error: "未收到结款截图文件，请重新选择图片后重试" }, { status: 400 });
    }
    let image: File;
    try {
      image = await prepareSettlementProof(entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取结款截图，请重新选择图片后重试";
      console.warn("[vision] settlement upload rejected", {type: entry.type, size: entry.size, reason: message});
      return Response.json({ error: message }, { status: 400 });
    }
    const started = Date.now();
    const data = await recognizeSettlementImage(image);
    console.info(`[vision] settlement user=${user.id} amount=${data.amount} in ${Date.now() - started}ms`);
    return Response.json({ data });
  } catch (error) {
    if (error instanceof Error && /未能识别/.test(error.message)) return Response.json({ error: error.message }, { status: 422 });
    if (error instanceof Error && /尚未配置/.test(error.message)) return Response.json({ error: error.message }, { status: 501 });
    if (error instanceof Error && /识图服务|JSON|模型/.test(error.message)) return Response.json({ error: error.message }, { status: 502 });
    return routeError(error);
  }
}
