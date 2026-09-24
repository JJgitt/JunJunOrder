type ShippableItem = {id: string; shippedAt?: string};
type TimelineOrder<T extends ShippableItem> = {items: T[]; settled: boolean; settledAt?: string};

export type PostReceiptTimelineEvent<T extends ShippableItem> =
    | {kind: "shipped"; at: string; item: T}
    | {kind: "settled"; at?: string};

/** Shipment is per item, while settlement is independent; show both in actual time order. */
export function postReceiptTimelineEvents<T extends ShippableItem>(order: TimelineOrder<T>, includeShipments: boolean, toMillis: (value: string) => number): PostReceiptTimelineEvent<T>[] {
    const events: PostReceiptTimelineEvent<T>[] = includeShipments
        ? order.items.filter(item => item.shippedAt).map(item => ({kind: "shipped", at: item.shippedAt!, item}))
        : [];
    if (order.settled) events.push({kind: "settled", at: order.settledAt});
    return events.sort((left, right) => {
        const leftTime = toMillis(left.at ?? ""), rightTime = toMillis(right.at ?? "");
        if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : 0;
        if (!Number.isFinite(rightTime)) return -1;
        return leftTime - rightTime;
    });
}
