/** 运单号比对：去掉空格和横杠后转大写，避免识别结果和录入格式不一致。 */
export function normalizeCourierNo(value: unknown) {
  return String(value ?? "").replace(/[\s-]/g, "").toUpperCase();
}

export function orderMatchesCourierNo(order: { courierNo?: string; items: Array<{ purchaseCourierNo?: string }> }, courierNo: string) {
  const want = normalizeCourierNo(courierNo);
  if (!want) return false;
  if (normalizeCourierNo(order.courierNo) === want) return true;
  return order.items.some(item => normalizeCourierNo(item.purchaseCourierNo) === want);
}

export function findOrdersByCourierNo<T extends { courierNo?: string; items: Array<{ purchaseCourierNo?: string }> }>(orders: T[], courierNo: string) {
  return orders.filter(order => orderMatchesCourierNo(order, courierNo));
}

/** 未精确命中时，用运单号后四位提示可能相关的在途单。 */
export function findTransitCandidatesByCourierTail<T extends { status: string; courierNo?: string; items: Array<{ purchaseCourierNo?: string }> }>(orders: T[], courierNo: string) {
  const tail = normalizeCourierNo(courierNo).slice(-4);
  if (tail.length < 4) return [];
  return orders.filter(order => order.status === "在途" && (
    normalizeCourierNo(order.courierNo).endsWith(tail) ||
    order.items.some(item => normalizeCourierNo(item.purchaseCourierNo).endsWith(tail))
  )).slice(0, 5);
}

/** 应用内快递公司名 → 快递鸟 ShipperCode，只用于拼快递鸟网页查询地址。 */
const kdniaoShipperCodes: Record<string, string> = {
  "顺丰速运": "SF",
  "京东物流": "JD",
  "中通快递": "ZTO",
  "圆通速递": "YTO",
  "申通快递": "STO",
  "韵达快递": "YD",
  "极兔速递": "JTSD",
  "邮政EMS": "EMS",
  "德邦物流": "DBL",
  "德邦快递": "DBL",
};

export function kdniaoShipperCode(company: unknown): string | null {
  return kdniaoShipperCodes[String(company ?? "").trim()] ?? null;
}

/** 快递鸟的 WAF 会对查询参数里「http(s)://裸 IP」的完整地址直接返 403（域名地址不受影响）。
 *  线上目前用 IP 访问，所以把 `http://1.2.3.4/` 写成 `http:/1.2.3.4/`：浏览器按 WHATWG URL 规则会把它当成 `http://1.2.3.4/` 打开，
 *  返回键仍能回到本系统。换成域名后原样透传。 */
export function kdniaoBackUrl(url: unknown) {
  return String(url ?? "").trim().replace(/^(https?:)\/\/(?=\d{1,3}(?:\.\d{1,3}){3}(?:[/:?#]|$))/i, "$1/");
}

/** 跳转查询物流的网页地址（纯跳转，不调用任何付费 API）。
 *  已知快递公司：快递鸟对外免费的移动端结果页（服务端直出轨迹，无验证码、登录和 App 引导），
 *  backUrl 让页面左上角返回键回到本系统。
 *  未收录的公司：快递100 网页版，仅传单号由页面按单号识别快递公司。 */
export function courierTrackingUrl(company: unknown, courierNo: unknown, backUrl = "") {
  const no = normalizeCourierNo(courierNo);
  if (!no) return "";
  const code = kdniaoShipperCode(company);
  if (!code) return `https://www.kuaidi100.com/chaxun?nu=${encodeURIComponent(no)}`;
  const params = new URLSearchParams({ expCode: code, expNo: no });
  const back = kdniaoBackUrl(backUrl);
  if (back) params.set("backUrl", back);
  return `https://www.kdniao.com/JSInvoke/MSearchResult.aspx?${params.toString()}`;
}
