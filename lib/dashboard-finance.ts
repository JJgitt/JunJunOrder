type FinanceItem = {qty: number; amount: number; salePrice?: number; shippedAt?: string};
type FinanceOrder = {createdAt: string; status: string; amount: number; items: FinanceItem[]};
type Calendar = {
    timestamp: (value: string | number) => number;
    dateKey: (value: string | number, timeZone: string) => string;
};
const validMonth = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const monthIndex = (value: string) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
const monthFromIndex = (index: number) => `${String(Math.floor(index / 12)).padStart(4, "0")}-${String(index % 12 + 1).padStart(2, "0")}`;

/** Show the recent year and every earlier month covered by the current order snapshot. */
export function financeMonthOptions(orders: FinanceOrder[], now: number, timeZone: string, calendar: Calendar, selectedMonth?: string) {
    const currentMonth = calendar.dateKey(now, timeZone).slice(0, 7);
    const currentIndex = monthIndex(currentMonth);
    let firstIndex = currentIndex - 11;
    const include = (value?: string) => {
        if (!value) return;
        const at = calendar.timestamp(value);
        if (!Number.isFinite(at) || at > now) return;
        const month = calendar.dateKey(at, timeZone).slice(0, 7);
        if (validMonth(month)) firstIndex = Math.min(firstIndex, monthIndex(month));
    };
    for (const order of orders) {
        include(order.createdAt);
        for (const item of order.items) include(item.shippedAt);
    }
    if (selectedMonth && validMonth(selectedMonth) && selectedMonth <= currentMonth) {
        firstIndex = Math.min(firstIndex, monthIndex(selectedMonth));
    }
    const months: string[] = [];
    for (let index = currentIndex; index >= firstIndex; index--) months.push(monthFromIndex(index));
    return months;
}

/** Purchase follows order creation; estimated sales and margin follow each item's shipment. */
export function monthlyFinance(orders: FinanceOrder[], now: number, timeZone: string, calendar: Calendar, selectedMonth?: string) {
    const currentMonth = calendar.dateKey(now, timeZone).slice(0, 7);
    const month = selectedMonth && validMonth(selectedMonth) && selectedMonth <= currentMonth ? selectedMonth : currentMonth;
    const inMonth = (value?: string) => {
        if (!value || !month) return false;
        const at = calendar.timestamp(value);
        return Number.isFinite(at) && at <= now && calendar.dateKey(at, timeZone).slice(0, 7) === month;
    };
    const cents = (value: number) => Number.isFinite(value) ? Math.round(value * 100) : 0;
    let purchaseCents = 0, salesCents = 0, soldCostCents = 0, unpricedShippedQuantity = 0;
    for (const order of orders) {
        if (order.status !== "已驳回" && inMonth(order.createdAt)) purchaseCents += cents(order.amount);
        for (const item of order.items) {
            if (!inMonth(item.shippedAt)) continue;
            if (item.salePrice == null || !Number.isFinite(item.salePrice) || item.salePrice <= 0) {
                unpricedShippedQuantity += item.qty;
                continue;
            }
            salesCents += cents(item.salePrice);
            soldCostCents += cents(item.amount);
        }
    }
    return {
        month,
        purchase: purchaseCents / 100,
        sales: salesCents / 100,
        profit: (salesCents - soldCostCents) / 100,
        unpricedShippedQuantity
    };
}
