import { inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { orderItems, purchaseOrders, users } from "@/db/schema";
import { normalizeCourierNo } from "@/lib/courier";

export type ReceiptMatch = {
  id: string;
  platform: string;
  platformNo: string;
  courierCompany: string;
  courierNo: string;
  status: string;
  purchaser: string;
  createdAt: string;
  title: string;
  itemCount: number;
  amount: number;
  items: Array<{
    id: string;
    title: string;
    sku: string;
    size: string;
    qty: number;
    amount: number;
    purchaseCourierCompany: string;
    purchaseCourierNo: string;
  }>;
};

/** 按运单号反查采购单：同时匹配订单头和商品行，忽略空格与大小写。 */
export async function lookupOrdersByCourierNo(courierNo: string): Promise<ReceiptMatch[]> {
  const normalized = normalizeCourierNo(courierNo);
  if (!normalized) return [];
  const db = getDb();
  const itemHits = await db.select({ orderId: orderItems.orderId }).from(orderItems).where(sql`replace(replace(upper(${orderItems.purchaseCourierNo}), ' ', ''), '-', '') = ${normalized}`);
  const headerHits = await db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(sql`replace(replace(upper(${purchaseOrders.courierNo}), ' ', ''), '-', '') = ${normalized}`);
  const ids = [...new Set([...itemHits.map(hit => hit.orderId), ...headerHits.map(hit => hit.id)])].slice(0, 20);
  if (!ids.length) return [];
  const rows = await db.select().from(purchaseOrders).where(inArray(purchaseOrders.id, ids));
  const itemRows = await db.select().from(orderItems).where(inArray(orderItems.orderId, ids));
  const purchaserIds = [...new Set(rows.map(row => row.purchaserId))];
  const people = purchaserIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, purchaserIds)) : [];
  const names = new Map(people.map(person => [person.id, person.name]));
  return rows.map(row => {
    const rawItems = itemRows.filter(item => item.orderId === row.id);
    const allShipped = rawItems.length > 0 && rawItems.every(item => item.shippedAt);
    const status = row.status === "已入库" ? (allShipped ? "已发货" : "待发货") : row.status;
    const items = rawItems.map(item => ({
      id: item.id,
      title: item.title,
      sku: item.sku,
      size: item.size,
      qty: item.qty,
      amount: item.amountCents / 100,
      purchaseCourierCompany: item.purchaseCourierCompany || row.courierCompany,
      purchaseCourierNo: item.purchaseCourierNo || row.courierNo,
    }));
    return {
      id: row.id,
      platform: row.platform,
      platformNo: row.platformOrderNo,
      courierCompany: row.courierCompany,
      courierNo: row.courierNo,
      status,
      purchaser: names.get(row.purchaserId) ?? "采购员",
      createdAt: row.createdAt,
      title: items[0]?.title ?? "",
      itemCount: items.length,
      amount: items.reduce((sum, item) => sum + item.amount, 0),
      items,
    };
  }).sort((left, right) => {
    if (left.status === "在途" && right.status !== "在途") return -1;
    if (left.status !== "在途" && right.status === "在途") return 1;
    return right.createdAt.localeCompare(left.createdAt);
  });
}
