export type CopyOrderItem = { title: string; sku: string; size: string; qty: number };
export type CopyOrder = { items: CopyOrderItem[] };

const clean = (value: unknown) => String(value ?? "").trim();

/** 「导出文案」首行时间：MMDD HH:mm:ss，按服务器时区。`now` 是服务器时钟的毫秒时间戳。 */
export function copyTimestamp(now: number, timeZone: string): string {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("month")}${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

/** 按 货号+商品名+尺码 合并数量。同一款的不同尺码排在一起，款和尺码都按首次出现的顺序。 */
export function aggregateCopyLines(orders: CopyOrder[]): CopyOrderItem[] {
  const groups = new Map<string, Map<string, CopyOrderItem>>();
  for (const order of orders) {
    for (const item of order.items ?? []) {
      const qty = Math.floor(Number(item.qty));
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const sku = clean(item.sku), title = clean(item.title), size = clean(item.size);
      if (!sku && !title) continue;
      const productKey = `${sku}\u0000${title}`;
      const sizes = groups.get(productKey) ?? new Map<string, CopyOrderItem>();
      const line = sizes.get(size);
      if (line) line.qty += qty;
      else sizes.set(size, { sku, title, size, qty });
      groups.set(productKey, sizes);
    }
  }
  return Array.from(groups.values()).flatMap(sizes => Array.from(sizes.values()));
}

/** 单行文案：`货号 商品名 尺码 ×数量`；货号和商品名相同（识图未拿到货号时系统用商品名兜底）只写一次，空字段跳过。 */
export function formatCopyLine(line: CopyOrderItem): string {
  const sku = clean(line.sku), title = clean(line.title), size = clean(line.size);
  const fields = sku && title && sku.toLowerCase() === title.toLowerCase() ? [title, size] : [sku, title, size];
  return `${fields.filter(Boolean).join(" ")} ×${line.qty}`;
}

/** 订单列表「导出文案」：时间头、表头、按款和尺码合并后的商品行、合计件数。 */
export function buildOrderCopyText(orders: CopyOrder[], now: number, timeZone: string): string {
  const lines = aggregateCopyLines(orders);
  const total = lines.reduce((sum, line) => sum + line.qty, 0);
  return [
    copyTimestamp(now, timeZone),
    "",
    "货号 商品名 尺码规格 数量",
    ...lines.map(formatCopyLine),
    "",
    `合计：${total}件`,
  ].join("\n");
}
