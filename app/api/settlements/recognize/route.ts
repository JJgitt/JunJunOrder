import { assertSameOrigin, requireAdmin, requireAppUser, routeError } from "@/lib/auth";
import { recognizeSettlementImage, visionConfigured } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireAppUser(request);
    requireAdmin(user);
    if (!visionConfigured()) return Response.json({ error: "尚未配置智能识图服务，请手动输入结款金额" }, { status: 501 });
    const image = (await request.formData()).get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/") || image.size > 5 * 1024 * 1024) {
      return Response.json({ error: "请选择 5MB 以内的结款截图" }, { status: 400 });
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
