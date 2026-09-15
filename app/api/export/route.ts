import { asc, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { orderItems, purchaseOrders, users } from "@/db/schema";
import { requireAdmin, requireAppUser, routeError } from "@/lib/auth";

export const dynamic="force-dynamic";
const csv=(value:unknown)=>`"${String(value??"").replaceAll('"','""')}"`;

export async function GET(request:Request){
  try{
    const user=await requireAppUser(request);
    requireAdmin(user);
    const db=getDb();
    const [orders,items,people]=await Promise.all([
      db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt)),
      db.select().from(orderItems).orderBy(asc(orderItems.createdAt)),
      db.select().from(users),
    ]);
    const names=new Map(people.map(person=>[person.id,person.name]));
    const itemsByOrder=new Map<string,typeof items>();
    for(const item of items){
      const list=itemsByOrder.get(item.orderId)??[];
      list.push(item);
      itemsByOrder.set(item.orderId,list);
    }
    const header=["采购单号","渠道","平台订单号","商品","货号","尺码","数量","采购金额","采购快递公司","快递单号","状态","结款状态","实际结款金额","结款时间","采购员","库位","二级平台单号","售价","发货单号","创建时间"];
    const rows=orders.flatMap(order=>{
      const lines=itemsByOrder.get(order.id)??[];
      return lines.map(item=>{
        const status=order.status==="已入库"?(item.shippedAt?"已发货":"待发货"):order.status;
        return [order.id,order.platform,order.platformOrderNo,item.title,item.sku,item.size,item.qty,(item.amountCents/100).toFixed(2),item.purchaseCourierCompany||order.courierCompany,item.purchaseCourierNo||order.courierNo,status,order.settled?"已结款":"未结款",order.settledAmountCents==null?"":(order.settledAmountCents/100).toFixed(2),order.settledAt??"",names.get(order.purchaserId),order.location,item.resaleOrderNo,item.salePriceCents==null?"":(item.salePriceCents/100).toFixed(2),item.outboundCourierNo,order.createdAt];
      });
    });
    const content="\uFEFF"+[header,...rows].map(row=>row.map(csv).join(",")).join("\r\n");
    return new Response(content,{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="junjun-orders-${new Date().toISOString().slice(0,10)}.csv"`,"cache-control":"no-store"}});
  }catch(error){
    return routeError(error);
  }
}
