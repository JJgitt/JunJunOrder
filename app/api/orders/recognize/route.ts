import { assertSameOrigin, requireAppUser, routeError } from "@/lib/auth";
import { recognizeOrderImages, visionConfigured } from "@/lib/vision";

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
    const data = await recognizeOrderImages(files);
    console.info(`[vision] user=${user.id} images=${files.length} items=${data.items.length} platform=${data.platform || "-"} orderNo=${data.platformNo || "-"} in ${Date.now() - started}ms`);
    if (!data.platform && !data.platformNo && !data.items.length && !data.courierCompany && !data.courierNo) return Response.json({ error: "没有从截图里识别到订单信息，请换更清晰的订单详情截图" }, { status: 422 });
    return Response.json({ data });
  } catch (error) {
    if (error instanceof Error && /识图服务|JSON|模型/.test(error.message)) return Response.json({ error: error.message }, { status: 502 });
    return routeError(error);
  }
}
