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

/** 跳转快递100 网页查询；只传运单号，不调用物流 API。 */
export function courierTrackingUrl(courierNo: unknown) {
  const no = normalizeCourierNo(courierNo);
  if (!no) return "";
  return `https://www.kuaidi100.com/chaxun?nu=${encodeURIComponent(no)}`;
}
