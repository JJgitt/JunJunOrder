import { hash } from "bcryptjs";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, inventory, inventoryLots, inventoryMovements, purchaseOrders, users } from "@/db/schema";
import { assertSameOrigin, requireAdmin, requireAppUser, routeError } from "@/lib/auth";

export const dynamic = "force-dynamic";

const now=()=>new Date().toISOString();
const uid=(prefix:string)=>`${prefix}_${crypto.randomUUID()}`;
const orderId=()=>`PO${new Date().toISOString().slice(0,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,6).toUpperCase()}`;
const string=(value:unknown)=>typeof value==="string"?value.trim():"";
const positiveInt=(value:unknown,fallback=1)=>Math.max(1,Math.floor(Number(value)||fallback));
const cents=(value:unknown)=>Math.max(0,Math.round(Number(value)*100));

async function snapshot(user:Awaited<ReturnType<typeof requireAppUser>>){
  const db=getDb();
  const rows=user.role==="admin"
    ?await db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt)).limit(500)
    :await db.select().from(purchaseOrders).where(eq(purchaseOrders.purchaserId,user.id)).orderBy(desc(purchaseOrders.createdAt)).limit(300);
  const people=user.role==="admin"?await db.select().from(users).orderBy(users.createdAt):[user];
  const names=new Map(people.map(person=>[person.id,person.name]));
  const orders=rows.map(row=>({
    id:row.id,platform:row.platform,platformNo:row.platformOrderNo,title:row.title,sku:row.sku,size:row.size,qty:row.qty,
    amount:row.amountCents/100,courierNo:row.courierNo,status:row.status,rejectReason:row.rejectReason??undefined,
    purchaserId:row.purchaserId,purchaser:names.get(row.purchaserId)??"采购员",createdAt:row.createdAt,
    location:row.location??undefined,resaleNo:row.resaleOrderNo??undefined,salePrice:row.salePriceCents==null?undefined:row.salePriceCents/100,
    outboundCourier:row.outboundCourierNo??undefined,
  }));
  let stock:Array<{sku:string;title:string;size:string;count:number;locations:string[]}>=[];
  if(user.role==="admin"){
    const [items,lots]=await Promise.all([db.select().from(inventory),db.select().from(inventoryLots).where(isNull(inventoryLots.shippedAt))]);
    stock=items.map(item=>({sku:item.sku,title:item.title,size:item.size,count:item.quantity,locations:Array.from(new Set(lots.filter(lot=>lot.sku===item.sku&&lot.size===item.size).map(lot=>lot.location)))}));
  }
  return {user,orders,stock,users:people.map(person=>({id:person.id,email:person.email,name:person.name,role:person.role,active:person.active}))};
}

export async function GET(request:Request){
  try{return Response.json(await snapshot(await requireAppUser(request)),{headers:{"cache-control":"no-store"}});}
  catch(error){return routeError(error);}
}

export async function POST(request:Request){
  try{
    assertSameOrigin(request);
    const user=await requireAppUser(request);
    const body=await request.json() as Record<string,unknown>;
    const action=string(body.action);
    const db=getDb();

    if(action==="create-order"){
      const platform=string(body.platform),platformNo=string(body.platformNo),title=string(body.title),sku=string(body.sku),size=string(body.size);
      if(!platform||!platformNo||!title||!sku||!size||cents(body.amount)<=0)return Response.json({error:"请完整填写采购订单必填项"},{status:400});
      const id=orderId(),timestamp=now();
      await db.transaction(async tx=>{
        await tx.insert(purchaseOrders).values({id,platform,platformOrderNo:platformNo,title,sku,size,qty:positiveInt(body.qty),amountCents:cents(body.amount),courierNo:string(body.courierNo),purchaserId:user.id,createdAt:timestamp,updatedAt:timestamp});
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"create",entityType:"purchase_order",entityId:id,detailJson:"{}"});
      });
      return Response.json({data:await snapshot(user),createdOrderId:id},{status:201});
    }

    if(action==="resubmit-order"){
      const id=string(body.orderId),platform=string(body.platform),platformNo=string(body.platformNo),title=string(body.title),sku=string(body.sku),size=string(body.size);
      if(!id||!platform||!platformNo||!title||!sku||!size||cents(body.amount)<=0)return Response.json({error:"请完整填写采购订单必填项"},{status:400});
      await db.transaction(async tx=>{
        const editableOrder=user.role==="admin"
          ?and(eq(purchaseOrders.id,id),eq(purchaseOrders.status,"已驳回"))
          :and(eq(purchaseOrders.id,id),eq(purchaseOrders.purchaserId,user.id),eq(purchaseOrders.status,"已驳回"));
        const changed=await tx.update(purchaseOrders).set({platform,platformOrderNo:platformNo,title,sku,size,qty:positiveInt(body.qty),amountCents:cents(body.amount),courierNo:string(body.courierNo),status:"待审核",rejectReason:null,updatedAt:now()}).where(editableOrder).returning({id:purchaseOrders.id});
        if(!changed.length)throw new Response(JSON.stringify({error:"订单不可修改或状态已变化"}),{status:409,headers:{"content-type":"application/json"}});
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"resubmit",entityType:"purchase_order",entityId:id,detailJson:"{}"});
      });
      return Response.json({data:await snapshot(user),createdOrderId:id});
    }

    if(action==="approve"||action==="reject"){
      requireAdmin(user);const id=string(body.orderId),reason=string(body.reason);
      if(!id)return Response.json({error:"缺少订单 ID"},{status:400});
      if(action==="reject"&&!reason)return Response.json({error:"驳回原因不能为空"},{status:400});
      await db.transaction(async tx=>{
        const changed=await tx.update(purchaseOrders).set({status:action==="approve"?"在途":"已驳回",rejectReason:action==="reject"?reason:null,auditorId:user.id,updatedAt:now()}).where(and(eq(purchaseOrders.id,id),eq(purchaseOrders.status,"待审核"))).returning({id:purchaseOrders.id});
        if(!changed.length)throw new Response(JSON.stringify({error:"订单状态已变化，请刷新后重试"}),{status:409,headers:{"content-type":"application/json"}});
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action,entityType:"purchase_order",entityId:id,detailJson:JSON.stringify({reason})});
      });
      return Response.json({data:await snapshot(user)});
    }

    if(action==="receive"){
      requireAdmin(user);const id=string(body.orderId),location=string(body.location);
      if(!id||!location)return Response.json({error:"订单与库位不能为空"},{status:400});
      await db.transaction(async tx=>{
        const [order]=await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id,id)).for("update").limit(1);
        if(!order)throw new Response(JSON.stringify({error:"订单不存在"}),{status:404,headers:{"content-type":"application/json"}});
        if(order.status!=="在途")throw new Response(JSON.stringify({error:order.receivedAt?"该包裹已完成入库，请勿重复操作":"只有在途订单可以入库"}),{status:409,headers:{"content-type":"application/json"}});
        const timestamp=now();
        await tx.update(purchaseOrders).set({status:"已入库",receivedAt:timestamp,location,updatedAt:timestamp}).where(eq(purchaseOrders.id,id));
        await tx.insert(inventory).values({sku:order.sku,size:order.size,title:order.title,quantity:order.qty,updatedAt:timestamp}).onConflictDoUpdate({target:[inventory.sku,inventory.size],set:{title:order.title,quantity:sql`${inventory.quantity}+${order.qty}`,updatedAt:timestamp}});
        await tx.insert(inventoryLots).values({orderId:id,sku:order.sku,size:order.size,qty:order.qty,location,receivedAt:timestamp});
        await tx.insert(inventoryMovements).values({id:uid("move"),orderId:id,sku:order.sku,size:order.size,changeQty:order.qty,type:"receive",location,actorId:user.id,createdAt:timestamp});
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"receive",entityType:"purchase_order",entityId:id,detailJson:JSON.stringify({location}),createdAt:timestamp});
      });
      return Response.json({data:await snapshot(user)});
    }

    if(action==="ship"){
      requireAdmin(user);const id=string(body.orderId),resaleNo=string(body.resaleNo),courier=string(body.courier),company=string(body.company)||"顺丰速运",sale=cents(body.salePrice);
      if(!id||!resaleNo||!courier||sale<=0)return Response.json({error:"请完整填写平台单号、售价和发货信息"},{status:400});
      await db.transaction(async tx=>{
        const [order]=await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id,id)).for("update").limit(1);
        if(!order)throw new Response(JSON.stringify({error:"订单不存在"}),{status:404,headers:{"content-type":"application/json"}});
        if(order.status!=="已入库"&&order.status!=="待发货")throw new Response(JSON.stringify({error:"当前状态不能发货"}),{status:409,headers:{"content-type":"application/json"}});
        const timestamp=now();
        await tx.update(purchaseOrders).set({status:"已发货",resalePlatform:string(body.resalePlatform)||"得物",resaleOrderNo:resaleNo,salePriceCents:sale,outboundCompany:company,outboundCourierNo:courier,shippedAt:timestamp,updatedAt:timestamp}).where(eq(purchaseOrders.id,id));
        await tx.update(inventory).set({quantity:sql`greatest(0,${inventory.quantity}-${order.qty})`,updatedAt:timestamp}).where(and(eq(inventory.sku,order.sku),eq(inventory.size,order.size)));
        await tx.update(inventoryLots).set({shippedAt:timestamp}).where(eq(inventoryLots.orderId,id));
        await tx.insert(inventoryMovements).values({id:uid("move"),orderId:id,sku:order.sku,size:order.size,changeQty:-order.qty,type:"ship",location:order.location,actorId:user.id,createdAt:timestamp});
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"ship",entityType:"purchase_order",entityId:id,detailJson:JSON.stringify({resaleNo,courier,salePriceCents:sale}),createdAt:timestamp});
      });
      return Response.json({data:await snapshot(user)});
    }

    if(action==="create-user"){
      requireAdmin(user);const email=string(body.email).toLowerCase(),name=string(body.name),password=string(body.password),role=string(body.role)||"buyer";
      if(!email.includes("@")||!name||password.length<8||!["admin","buyer"].includes(role))return Response.json({error:"请填写有效邮箱、姓名和至少 8 位密码"},{status:400});
      const id=uid("usr"),timestamp=now();
      await db.transaction(async tx=>{
        await tx.insert(users).values({id,email,name,passwordHash:await hash(password,12),role:role as "admin"|"buyer",createdAt:timestamp,updatedAt:timestamp});
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"create_user",entityType:"user",entityId:id,detailJson:JSON.stringify({email,role}),createdAt:timestamp});
      });
      return Response.json({data:await snapshot(user)},{status:201});
    }

    if(action==="set-user-role"){
      requireAdmin(user);const targetId=string(body.userId),role=string(body.role);
      if(!targetId||!["admin","buyer"].includes(role))return Response.json({error:"角色参数错误"},{status:400});
      if(targetId===user.id&&role!=="admin")return Response.json({error:"不能取消自己的管理员权限"},{status:409});
      const changed=await db.update(users).set({role:role as "admin"|"buyer",updatedAt:now()}).where(eq(users.id,targetId)).returning({id:users.id});
      if(!changed.length)return Response.json({error:"成员不存在"},{status:404});
      return Response.json({data:await snapshot(user)});
    }

    if(action==="set-user-active"){
      requireAdmin(user);const targetId=string(body.userId),active=body.active===true;
      if(!targetId)return Response.json({error:"缺少成员 ID"},{status:400});
      if(targetId===user.id&&!active)return Response.json({error:"不能停用自己的账号"},{status:409});
      const changed=await db.update(users).set({active,updatedAt:now()}).where(eq(users.id,targetId)).returning({id:users.id});
      if(!changed.length)return Response.json({error:"成员不存在"},{status:404});
      return Response.json({data:await snapshot(user)});
    }

    return Response.json({error:"不支持的操作"},{status:400});
  }catch(error){return routeError(error);}
}
