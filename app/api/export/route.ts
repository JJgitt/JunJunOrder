import { asc, desc, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { orderItems, purchaseOrders, users } from "@/db/schema";
import { assertSameOrigin, requireAdmin, requireAppUser, routeError } from "@/lib/auth";
import { csvCell } from "@/lib/export-csv";
import { createOrdersWorkbook } from "@/lib/order-export";
import { serverClock } from "@/lib/server-time";
import { dateKey, formatDateTime } from "@/lib/time";

export const dynamic="force-dynamic";

export async function GET(request:Request){
  try{
    const user=await requireAppUser(request);
    requireAdmin(user);
    const clock=serverClock();
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
        return [order.id,order.platform,order.platformOrderNo,item.title,item.sku,item.size,item.qty,(item.amountCents/100).toFixed(2),item.purchaseCourierCompany||order.courierCompany,item.purchaseCourierNo||order.courierNo,status,order.settled?"已结款":"未结款",order.settledAmountCents==null?"":(order.settledAmountCents/100).toFixed(2),order.settledAt?formatDateTime(order.settledAt,clock.timeZone):"",names.get(order.purchaserId),order.location,item.resaleOrderNo,item.salePriceCents==null?"":(item.salePriceCents/100).toFixed(2),item.outboundCourierNo,formatDateTime(order.createdAt,clock.timeZone)];
      });
    });
    const content="\uFEFF"+[header,...rows].map(row=>row.map(csvCell).join(",")).join("\r\n");
    return new Response(content,{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="junjun-orders-${dateKey(clock.now,clock.timeZone)}.csv"`,"cache-control":"no-store"}});
  }catch(error){
    return routeError(error);
  }
}

export async function POST(request:Request){
  try{
    assertSameOrigin(request);
    const user=await requireAppUser(request);
    requireAdmin(user);
    const body=await request.json() as {orderIds?:unknown};
    const ids=Array.from(new Set((Array.isArray(body.orderIds)?body.orderIds:[]).filter((value):value is string=>typeof value==="string").map(value=>value.trim()).filter(Boolean))).slice(0,500);
    if(!ids.length)return Response.json({error:"请选择要导出的订单"},{status:400});
    const db=getDb();
    const [orders,items]=await Promise.all([
      db.select({id:purchaseOrders.id,platformOrderNo:purchaseOrders.platformOrderNo,courierNo:purchaseOrders.courierNo}).from(purchaseOrders).where(inArray(purchaseOrders.id,ids)),
      db.select({orderId:orderItems.orderId,title:orderItems.title,size:orderItems.size,qty:orderItems.qty,purchaseCourierNo:orderItems.purchaseCourierNo}).from(orderItems).where(inArray(orderItems.orderId,ids)).orderBy(asc(orderItems.createdAt)),
    ]);
    if(!orders.length)return Response.json({error:"未找到可导出的订单"},{status:404});
    const index=new Map(ids.map((id,position)=>[id,position]));
    items.sort((left,right)=>(index.get(left.orderId)??ids.length)-(index.get(right.orderId)??ids.length));
    const clock=serverClock();
    const workbook=await createOrdersWorkbook(orders,items,clock.now);
    return new Response(workbook,{headers:{
      "content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition":`attachment; filename="junjun-orders-${dateKey(clock.now,clock.timeZone)}.xlsx"`,
      "cache-control":"no-store",
    }});
  }catch(error){
    return routeError(error);
  }
}
