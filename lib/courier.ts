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

/** 跳转查询物流的网页地址（零成本方案）：快递100网页版查询页。
 *  已知快递公司携带 com 参数预选公司，其他/自填公司仅传单号，由页面按单号智能识别。 */
const trackingCompanyCodes: Record<string, string> = {
  "顺丰速运": "shunfeng",
  "京东物流": "jd",
  "中通快递": "zhongtong",
  "圆通速递": "yuantong",
  "申通快递": "shentong",
  "韵达快递": "yunda",
  "极兔速递": "jtexpress",
  "邮政EMS": "ems",
};

export function courierTrackingUrl(company: unknown, courierNo: unknown) {
  const no = normalizeCourierNo(courierNo);
  if (!no) return "";
  const com = trackingCompanyCodes[String(company ?? "").trim()];
  return `https://www.kuaidi100.com/chaxun?${com ? `com=${com}&` : ""}nu=${encodeURIComponent(no)}`;
}
