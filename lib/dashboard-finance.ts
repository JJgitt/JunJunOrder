type FinanceItem = {qty: number; amount: number; salePrice?: number; shippedAt?: string};
type FinanceOrder = {createdAt: string; status: string; amount: number; items: FinanceItem[]};
type Calendar = {
    timestamp: (value: string | number) => number;
    dateKey: (value: string | number, timeZone: string) => string;
};

/** Purchase follows order creation; estimated sales and margin follow each item's shipment. */
export function monthlyFinance(orders: FinanceOrder[], now: number, timeZone: string, calendar: Calendar) {
    const month = calendar.dateKey(now, timeZone).slice(0, 7);
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
