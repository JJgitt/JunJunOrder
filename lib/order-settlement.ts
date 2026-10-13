/** Raw database stages and their administrator-facing shipment-derived labels. */
export function isSettlementStage(status: string): boolean {
    return ["在途", "已入库", "待发货", "已发货"].includes(status);
}

export function canSettleOrder(order: {status: string; settled: boolean}): boolean {
    return !order.settled && isSettlementStage(order.status);
}
