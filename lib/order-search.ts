export type OrderSearchMode = "and" | "or" | "xor";
export type OrderSearchField = "all" | "orderNo" | "title" | "sku" | "size" | "purchaseCourier" | "outboundCourier" | "purchaser";
export type OrderSearchCondition = {id: string; field: OrderSearchField; value: string};
export type OrderSearchState = {query: string; searchConditions: OrderSearchCondition[]; searchMode: OrderSearchMode};

export const initialOrderSearchState: OrderSearchState = {query: "", searchConditions: [], searchMode: "and"};

export const orderSearchFields: ReadonlyArray<{value: OrderSearchField; label: string; adminOnly?: boolean}> = [
    {value: "all", label: "全部字段"},
    {value: "orderNo", label: "订单号"},
    {value: "title", label: "商品名称"},
    {value: "sku", label: "货号"},
    {value: "size", label: "尺码"},
    {value: "purchaseCourier", label: "采购快递"},
    {value: "outboundCourier", label: "发货快递", adminOnly: true},
    {value: "purchaser", label: "采购员", adminOnly: true}
];

type SearchableOrder = {
    id: string; platformNo: string; title: string; purchaser?: string;
    courierCompany?: string; courierNo?: string;
    items: Array<{
        title: string; sku: string; size: string;
        purchaseCourierCompany?: string; purchaseCourierNo?: string;
        outboundCompany?: string; outboundCourier?: string;
    }>;
};

function fieldValues(order: SearchableOrder, field: OrderSearchField, role: "admin" | "buyer"): Array<string | undefined> {
    switch (field) {
        case "orderNo": return [order.id, order.platformNo];
        case "title": return [order.title, ...order.items.map(item => item.title)];
        case "sku": return order.items.map(item => item.sku);
        case "size": return order.items.map(item => item.size);
        case "purchaseCourier": return [order.courierCompany, order.courierNo, ...order.items.flatMap(item => [item.purchaseCourierCompany, item.purchaseCourierNo])];
        case "outboundCourier": return role === "admin" ? order.items.flatMap(item => [item.outboundCompany, item.outboundCourier]) : [];
        case "purchaser": return role === "admin" ? [order.purchaser] : [];
        case "all": return orderSearchFields.filter(option => option.value !== "all" && (!option.adminOnly || role === "admin"))
            .flatMap(option => fieldValues(order, option.value, role));
    }
}

/** Empty rows are drafts. Conditions match an order across its items; legacy "xor" now excludes any match. */
export function matchesOrderSearch(order: SearchableOrder, search: OrderSearchState, role: "admin" | "buyer"): boolean {
    const conditions = [{field: "all" as const, value: search.query}, ...search.searchConditions]
        .map(condition => ({field: condition.field, value: condition.value.trim().toLowerCase()}))
        .filter(condition => condition.value);
    if (!conditions.length) return true;
    const matches = (condition: typeof conditions[number]) => fieldValues(order, condition.field, role)
        .some(value => value?.toLowerCase().includes(condition.value));
    if (search.searchMode === "xor") return !conditions.some(matches);
    return search.searchMode === "or" ? conditions.some(matches) : conditions.every(matches);
}
