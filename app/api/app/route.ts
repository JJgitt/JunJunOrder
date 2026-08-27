import { and, desc, eq, isNull } from "drizzle-orm";
import { getD1, getDb } from "@/db";
import { auditLogs, inventory, inventoryLots, purchaseOrders, users } from "@/db/schema";
import { requireAdmin, requireAppUser, routeError } from "@/lib/auth";

export const dynamic = "force-dynamic";

const now = () => new Date().toISOString();
const uid = (prefix:string) => `${prefix}_${crypto.randomUUID()}`;
const orderId = () => `PO${new Date().toISOString().slice(0,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,6).toUpperCase()}`;
const string = (value:unknown) => typeof value === "string" ? value.trim() : "";
const positiveInt = (value:unknown, fallback=1) => Math.max(1, Math.floor(Number(value) || fallback));
const cents = (value:unknown) => Math.max(0, Math.round(Number(value) * 100));

async function snapshot(user: Awaited<ReturnType<typeof requireAppUser>>) {
  const db = getDb();
  const rows = user.role === "admin"
    ? await db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt)).limit(500)
    : await db.select().from(purchaseOrders).where(eq(purchaseOrders.purchaserId,user.id)).orderBy(desc(purchaseOrders.createdAt)).limit(300);
  const people = user.role === "admin" ? await db.select().from(users).orderBy(users.createdAt) : [user];
  const names = new Map(people.map(person => [person.id,person.name]));
  const orders = rows.map(row => ({
    id:row.id, platform:row.platform, platformNo:row.platformOrderNo, title:row.title, sku:row.sku, size:row.size, qty:row.qty,
    amount:row.amountCents/100, courierNo:row.courierNo, status:row.status, rejectReason:row.rejectReason ?? undefined,
    purchaserId:row.purchaserId, purchaser:names.get(row.purchaserId) ?? "采购员", createdAt:row.createdAt,
    location:row.location ?? undefined, resaleNo:row.resaleOrderNo ?? undefined, salePrice:row.salePriceCents == null ? undefined : row.salePriceCents/100,
    outboundCourier:row.outboundCourierNo ?? undefined,
  }));
  let stock: Array<{sku:string;title:string;size:string;count:number;locations:string[]}> = [];
  if (user.role === "admin") {
    const [items,lots] = await Promise.all([db.select().from(inventory),db.select().from(inventoryLots).where(isNull(inventoryLots.shippedAt))]);
    stock = items.map(item => ({ sku:item.sku,title:item.title,size:item.size,count:item.quantity,locations:Array.from(new Set(lots.filter(lot => lot.sku === item.sku && lot.size === item.size).map(lot => lot.location))) }));
  }
  return { user,orders,stock,users:people.map(person => ({ id:person.id,email:person.email,name:person.name,role:person.role,active:person.active })) };
}

export async function GET(request:Request) {
  try { return Response.json(await snapshot(await requireAppUser(request)), { headers:{ "cache-control":"no-store" } }); }
  catch(error) { return routeError(error); }
}

export async function POST(request:Request) {
  try {
    const user = await requireAppUser(request);
    const body = await request.json() as Record<string,unknown>;
    const action = string(body.action);
    const db = getDb(); const d1 = getD1();

    if (action === "create-order") {
      const platform=string(body.platform), platformNo=string(body.platformNo), title=string(body.title), sku=string(body.sku), size=string(body.size);
      if (!platform || !platformNo || !title || !sku || !size || cents(body.amount) <= 0) return Response.json({error:"请完整填写采购订单必填项"},{status:400});
      const id=orderId(); const timestamp=now();
      await db.insert(purchaseOrders).values({ id,platform,platformOrderNo:platformNo,title,sku,size,qty:positiveInt(body.qty),amountCents:cents(body.amount),courierNo:string(body.courierNo),purchaserId:user.id,createdAt:timestamp,updatedAt:timestamp });
      await db.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"create",entityType:"purchase_order",entityId:id,detailJson:"{}"});
      return Response.json({ data:await snapshot(user), createdOrderId:id },{status:201});
    }

    if (action === "resubmit-order") {
      const id=string(body.orderId),platform=string(body.platform),platformNo=string(body.platformNo),title=string(body.title),sku=string(body.sku),size=string(body.size);
      if(!id||!platform||!platformNo||!title||!sku||!size||cents(body.amount)<=0)return Response.json({error:"请完整填写采购订单必填项"},{status:400});
      const changed=await db.update(purchaseOrders).set({platform,platformOrderNo:platformNo,title,sku,size,qty:positiveInt(body.qty),amountCents:cents(body.amount),courierNo:string(body.courierNo),status:"待审核",rejectReason:null,updatedAt:now()}).where(and(eq(purchaseOrders.id,id),eq(purchaseOrders.purchaserId,user.id),eq(purchaseOrders.status,"已驳回"))).returning({id:purchaseOrders.id});
      if(!changed.length)return Response.json({error:"订单不可修改或状态已变化"},{status:409});
      await db.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"resubmit",entityType:"purchase_order",entityId:id,detailJson:"{}"});
      return Response.json({data:await snapshot(user),createdOrderId:id});
    }

    if (action === "approve" || action === "reject") {
      requireAdmin(user); const id=string(body.orderId); const reason=string(body.reason); if (!id) return Response.json({error:"缺少订单 ID"},{status:400});
      if (action === "reject" && !reason) return Response.json({error:"驳回原因不能为空"},{status:400});
      const result=await db.update(purchaseOrders).set({ status:action === "approve" ? "在途" : "已驳回",rejectReason:action === "reject" ? reason : null,auditorId:user.id,updatedAt:now() }).where(and(eq(purchaseOrders.id,id),eq(purchaseOrders.status,"待审核"))).returning({id:purchaseOrders.id});
      if (!result.length) return Response.json({error:"订单状态已变化，请刷新后重试"},{status:409});
      await db.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action,entityType:"purchase_order",entityId:id,detailJson:JSON.stringify({reason})});
      return Response.json({data:await snapshot(user)});
    }

    if (action === "receive") {
      requireAdmin(user); const id=string(body.orderId),location=string(body.location); if (!id || !location) return Response.json({error:"订单与库位不能为空"},{status:400});
      const [order]=await db.select().from(purchaseOrders).where(eq(purchaseOrders.id,id)).limit(1);
      if (!order) return Response.json({error:"订单不存在"},{status:404});
      if (order.status !== "在途") return Response.json({error:order.receivedAt ? "该包裹已完成入库，请勿重复操作" : "只有在途订单可以入库"},{status:409});
      const token=now(), movementId=uid("move"), auditId=uid("audit");
      await d1.batch([
        d1.prepare("UPDATE purchase_orders SET status='已入库',received_at=?1,location=?2,updated_at=?1 WHERE id=?3 AND status='在途'").bind(token,location,id),
        d1.prepare(`INSERT INTO inventory (sku,size,title,quantity,updated_at) SELECT sku,size,title,qty,?1 FROM purchase_orders WHERE id=?2 AND received_at=?1
          ON CONFLICT(sku,size) DO UPDATE SET title=excluded.title,quantity=inventory.quantity+excluded.quantity,updated_at=excluded.updated_at`).bind(token,id),
        d1.prepare("INSERT OR IGNORE INTO inventory_lots (order_id,sku,size,qty,location,received_at) SELECT id,sku,size,qty,?2,?1 FROM purchase_orders WHERE id=?3 AND received_at=?1").bind(token,location,id),
        d1.prepare("INSERT INTO inventory_movements (id,order_id,sku,size,change_qty,type,location,actor_id,created_at) SELECT ?1,id,sku,size,qty,'receive',?2,?3,?4 FROM purchase_orders WHERE id=?5 AND received_at=?4").bind(movementId,location,user.id,token,id),
        d1.prepare("INSERT INTO audit_logs (id,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?1,?2,'receive','purchase_order',?3,?4,?5)").bind(auditId,user.id,id,JSON.stringify({location}),token),
      ]);
      return Response.json({data:await snapshot(user)});
    }

    if (action === "ship") {
      requireAdmin(user); const id=string(body.orderId),resaleNo=string(body.resaleNo),courier=string(body.courier),company=string(body.company)||"顺丰速运";
      if (!id || !resaleNo || !courier || cents(body.salePrice)<=0) return Response.json({error:"请完整填写平台单号、售价和发货信息"},{status:400});
      const [order]=await db.select().from(purchaseOrders).where(eq(purchaseOrders.id,id)).limit(1); if(!order)return Response.json({error:"订单不存在"},{status:404});
      if (order.status !== "已入库" && order.status !== "待发货") return Response.json({error:"当前状态不能发货"},{status:409});
      const token=now(),movementId=uid("move"),auditId=uid("audit"),sale=cents(body.salePrice);
      await d1.batch([
        d1.prepare("UPDATE purchase_orders SET status='已发货',resale_platform=?1,resale_order_no=?2,sale_price_cents=?3,outbound_company=?4,outbound_courier_no=?5,shipped_at=?6,updated_at=?6 WHERE id=?7 AND status IN ('已入库','待发货')").bind(string(body.resalePlatform)||"得物",resaleNo,sale,company,courier,token,id),
        d1.prepare(`UPDATE inventory SET quantity=MAX(0,quantity-(SELECT qty FROM purchase_orders WHERE id=?1)),updated_at=?2
          WHERE (sku,size)=(SELECT sku,size FROM purchase_orders WHERE id=?1) AND EXISTS(SELECT 1 FROM purchase_orders WHERE id=?1 AND shipped_at=?2)`).bind(id,token),
        d1.prepare("UPDATE inventory_lots SET shipped_at=?1 WHERE order_id=?2 AND EXISTS(SELECT 1 FROM purchase_orders WHERE id=?2 AND shipped_at=?1)").bind(token,id),
        d1.prepare("INSERT INTO inventory_movements (id,order_id,sku,size,change_qty,type,location,actor_id,created_at) SELECT ?1,id,sku,size,-qty,'ship',location,?2,?3 FROM purchase_orders WHERE id=?4 AND shipped_at=?3").bind(movementId,user.id,token,id),
        d1.prepare("INSERT INTO audit_logs (id,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?1,?2,'ship','purchase_order',?3,?4,?5)").bind(auditId,user.id,id,JSON.stringify({resaleNo,courier,salePriceCents:sale}),token),
      ]);
      return Response.json({data:await snapshot(user)});
    }

    if (action === "set-user-role") {
      requireAdmin(user); const targetId=string(body.userId),role=string(body.role); if (!targetId || !["admin","buyer"].includes(role)) return Response.json({error:"角色参数错误"},{status:400});
      if (targetId === user.id && role !== "admin") return Response.json({error:"不能取消自己的管理员权限"},{status:409});
      await db.update(users).set({role:role as "admin"|"buyer",updatedAt:now()}).where(eq(users.id,targetId));
      return Response.json({data:await snapshot(user)});
    }

    return Response.json({error:"不支持的操作"},{status:400});
  } catch(error) { return routeError(error); }
}
