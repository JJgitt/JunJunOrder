export const ORDER_PAGE_SIZE = 50;

/** Keep short lists intact; clamp stale pages when filters or refreshed data shrink. */
export function paginateOrders<T>(orders: T[], requestedPage: number, pageSize = ORDER_PAGE_SIZE) {
    const total = orders.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Number.isFinite(requestedPage) ? Math.min(pageCount, Math.max(1, Math.floor(requestedPage))) : 1;
    const start = (page - 1) * pageSize;
    const items = total > pageSize ? orders.slice(start, start + pageSize) : orders;
    return {items, page, pageCount, total, start: total ? start + 1 : 0, end: start + items.length, paginated: total > pageSize};
}
