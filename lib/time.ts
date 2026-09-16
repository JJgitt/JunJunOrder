export type ServerClock = { now: string; timeZone: string };

/** PostgreSQL may return a space separator, microseconds and a short +08
 * offset; normalize to ISO before parsing so Safari and Chromium agree. */
export function timestamp(value: string | number): number {
  if (typeof value === "number") return value;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/);
  if (!match) return Number.NaN;
  const fraction = match[3] ? match[3].slice(0, 4).padEnd(4, "0") : "";
  const raw = match[4];
  const zone = raw === "Z" ? raw : raw.length === 3 ? `${raw}:00` : raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  return Date.parse(`${match[1]}T${match[2]}${fraction}${zone}`);
}

export function dateKey(value: string | number, timeZone: string): string {
  const date = new Date(timestamp(value));
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (name: string) => parts.find(item => item.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function formatDateTime(value: string | undefined, timeZone: string): string {
  if (!value || !Number.isFinite(timestamp(value))) return "未记录";
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(timestamp(value));
}

export function dayRange(now: number, timeZone: string, days: number) {
  const end = dateKey(now, timeZone);
  // Calendar arithmetic, not subtracting 24 hours from a zoned instant (DST).
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { start: start.toISOString().slice(0, 10), end };
}

export function waitingLabel(since: string | undefined, now: number): string {
  if (!since || !Number.isFinite(timestamp(since))) return "暂无待审核订单";
  const minutes = Math.max(0, Math.floor((now - timestamp(since)) / 60000));
  return minutes < 1 ? "最早一笔等待不足 1 分钟" : `最早一笔已等待 ${minutes} 分钟`;
}
