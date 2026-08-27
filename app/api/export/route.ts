import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { purchaseOrders, users } from "@/db/schema";
import { requireAdmin, requireAppUser, routeError } from "@/lib/auth";

export const dynamic="force-dynamic";
const csv=(value:unknown)=>`"${String(value??"").replaceAll('"','""')}"`;

export async function GET(request:Request){try{const user=await requireAppUser(request);requireAdmin(user);const db=getDb();const [orders,people]=await Promise.all([db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt)),db.select().from(users)]);const names=new Map(people.map(person=>[person.id,person.name]));const header=["采购单号","渠道","平台订单号","商品","货号","尺码","数量","采购金额","快递单号","状态","采购员","库位","二手平台单号","售价","发货单号","创建时间"];const rows=orders.map(order=>[order.id,order.platform,order.platformOrderNo,order.title,order.sku,order.size,order.qty,(order.amountCents/100).toFixed(2),order.courierNo,order.status,names.get(order.purchaserId),order.location,order.resaleOrderNo,order.salePriceCents==null?"":(order.salePriceCents/100).toFixed(2),order.outboundCourierNo,order.createdAt]);const content="\uFEFF"+[header,...rows].map(row=>row.map(csv).join(",")).join("\r\n");return new Response(content,{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="junjun-orders-${new Date().toISOString().slice(0,10)}.csv"`,"cache-control":"no-store"}});}catch(error){return routeError(error);}}
