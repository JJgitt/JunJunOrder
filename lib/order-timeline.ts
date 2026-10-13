type ShippableItem = {id: string; shippedAt?: string};
type TimelineOrder<T extends ShippableItem> = {items: T[]; receivedAt?: string; settled: boolean; settledAt?: string};

export type PostReceiptTimelineEvent<T extends ShippableItem> =
    | {kind: "received"; at: string}
    | {kind: "shipped"; at: string; item: T}
    | {kind: "settled"; at?: string};

/** Receipt and item shipments are independent of settlement; show all in actual time order. */
export function postReceiptTimelineEvents<T extends ShippableItem>(order: TimelineOrder<T>, includeShipments: boolean, toMillis: (value: string) => number): PostReceiptTimelineEvent<T>[] {
    const events: PostReceiptTimelineEvent<T>[] = includeShipments
        ? order.items.filter(item => item.shippedAt).map(item => ({kind: "shipped", at: item.shippedAt!, item}))
        : [];
    if (order.receivedAt) events.push({kind: "received", at: order.receivedAt});
    if (order.settled) events.push({kind: "settled", at: order.settledAt});
    return events.sort((left, right) => {
        const leftTime = toMillis(left.at ?? ""), rightTime = toMillis(right.at ?? "");
        if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : 0;
        if (!Number.isFinite(rightTime)) return -1;
        return leftTime - rightTime;
    });
}
