import { requireAppUser, routeError } from "@/lib/auth";
import { normalizeCourierNo } from "@/lib/courier";
import { kdniaoConfigured, kdniaoShipperCode, queryTracking } from "@/lib/tracking";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 订单详情「物流轨迹」应用内查询：登录后调用快递鸟「在途监控即时查询」（RequestType=8001）。
 *  未配置 KDNIAO_*、快递公司未收录或快递鸟返回业务失败时给 ok:false + 原因，由前端回退到快递100网页跳转。
 *  顺丰单号需带 tail 参数（收/寄件人手机号后 4 位），前端已提供输入框。 */
export async function GET(request: Request) {
  try {
    await requireAppUser(request);
    const params = new URL(request.url).searchParams;
    const logisticCode = normalizeCourierNo(params.get("no") ?? "");
    const company = (params.get("company") ?? "").trim();
    const customerName = (params.get("tail") ?? "").replace(/\D/g, "").slice(0, 4);
    if (!logisticCode) return Response.json({ ok: false, message: "缺少快递单号" }, { status: 400 });
    if (!kdniaoShipperCode(company)) return Response.json({ ok: false, message: `暂不支持「${company || "该快递公司"}」的应用内查询，请改用网页查询` }, { status: 400 });
    if (!kdniaoConfigured()) return Response.json({ ok: false, message: "服务器尚未配置快递鸟 API（KDNIAO_EBUSINESS_ID / KDNIAO_API_KEY），请在服务器 .env 配置后重启" }, { status: 501 });
    return Response.json(await queryTracking({ company, logisticCode, customerName }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}
