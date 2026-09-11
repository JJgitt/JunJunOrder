import { assertSameOrigin, requireAdmin, requireAppUser, routeError } from "@/lib/auth";
import { normalizeCourierNo } from "@/lib/courier";
import { lookupOrdersByCourierNo } from "@/lib/receipt-lookup";
import { recognizeWaybillImage, visionConfigured } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function recognizeFromLegacyOcr(image: File) {
  const endpoint = process.env.OCR_ENDPOINT, token = process.env.OCR_TOKEN;
  if (!endpoint) throw new Error("尚未配置智能识图服务，请手动输入快递单号或联系管理员设置 VISION_API_BASE / VISION_API_KEY / VISION_MODEL");
  const outbound = new FormData();
  outbound.set("image", image);
  const headers: HeadersInit = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(endpoint, { method: "POST", headers, body: outbound });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error ?? "OCR 服务调用失败"));
  const nested = (result.data ?? {}) as Record<string, unknown>;
  const courierNo = String(result.courierNo ?? result.courier_no ?? nested.courierNo ?? nested.courier_no ?? "").replace(/[\s-]/g, "").trim();
  const courierCompany = String(result.courierCompany ?? result.courier_company ?? nested.courierCompany ?? nested.courier_company ?? "").trim();
  if (!courierNo) throw new Error("未能识别快递单号，请重新拍照或手动输入");
  return { courierCompany, courierNo };
}

/** 按运单号反查采购单，供拍照识别后或手动改单号时使用。 */
export async function GET(request: Request) {
  try {
    requireAdmin(await requireAppUser(request));
    const courierNo = new URL(request.url).searchParams.get("courierNo") ?? "";
    if (!normalizeCourierNo(courierNo)) return Response.json({ error: "请输入快递单号" }, { status: 400 });
    return Response.json({ matches: await lookupOrdersByCourierNo(courierNo) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}

/** 管理员上传快递面单：优先走 VISION_* 智能识图，未配置时回退 OCR_ENDPOINT，再按运单号反查采购单。 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireAppUser(request);
    requireAdmin(user);
    const incoming = await request.formData();
    const image = incoming.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/") || image.size > 8 * 1024 * 1024) return Response.json({ error: "请选择 8MB 以内的面单图片" }, { status: 400 });
    const started = Date.now();
    const recognized = visionConfigured() ? await recognizeWaybillImage(image) : await recognizeFromLegacyOcr(image);
    const matches = await lookupOrdersByCourierNo(recognized.courierNo);
    console.info(`[vision] waybill user=${user.id} courierNo=${recognized.courierNo} matches=${matches.length} in ${Date.now() - started}ms`);
    return Response.json({ courierNo: recognized.courierNo, courierCompany: recognized.courierCompany, matches });
  } catch (error) {
    if (error instanceof Error && /尚未配置/.test(error.message)) return Response.json({ error: error.message }, { status: 501 });
    if (error instanceof Error && /未能识别/.test(error.message)) return Response.json({ error: error.message }, { status: 422 });
    if (error instanceof Error && /识图服务|智能识图|OCR|JSON|模型/.test(error.message)) return Response.json({ error: error.message }, { status: 502 });
    return routeError(error);
  }
}
