export type MonthlyGrossProfitRecord = {
  month: string;
  grossProfit: number;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export function validAccountingMonth(value: unknown): value is string {
  return typeof value === "string" && value.length === 7 && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value) && !value.startsWith("0000-");
}

/** Convert a manually entered yuan value to exact integer cents without rounding. */
export function parseGrossProfitCents(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const amount = String(value).trim();
  if (!/^[+-]?(?:[0-9]+(?:\.[0-9]{1,2})?|\.[0-9]{1,2})$/.test(amount)) return null;
  const negative = amount.startsWith("-");
  const [whole, fraction = ""] = amount.replace(/^[+-]/, "").split(".");
  const significantWhole = whole.replace(/^0+/, "") || "0";
  if (significantWhole.length > 8) return null;
  // With at most eight whole-number digits every integer operation is exact.
  const cents = Number(significantWhole) * 100 + Number(fraction.padEnd(2, "0"));
  const signedCents = negative ? -cents : cents;
  if (signedCents < -2147483648 || signedCents > 2147483647) return null;
  return signedCents === 0 ? 0 : signedCents;
}
