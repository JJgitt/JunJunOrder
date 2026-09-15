import { hash } from "bcryptjs";
import { unlink } from "node:fs/promises";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, inventory, inventoryLots, inventoryMovements, orderImages, orderItems, purchaseOrders, users } from "@/db/schema";
import { assertSameOrigin, requireAdmin, requireAppUser, routeError } from "@/lib/auth";
import { uploadPath } from "@/lib/file-storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const now=()=>new Date().toISOString();
const uid=(prefix:string)=>`${prefix}_${crypto.randomUUID()}`;
const orderId=()=>`PO${new Date().toISOString().slice(0,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,6).toUpperCase()}`;
const string=(value:unknown)=>typeof value==="string"?value.trim():"";
const positiveInt=(value:unknown,fallback=1)=>Math.max(1,Math.floor(Number(value)||fallback));
const cents=(value:unknown)=>Math.max(0,Math.round(Number(value)*100));
const conflict=(message:string)=>new Response(JSON.stringify({error:message}),{status:409,headers:{"content-type":"application/json"}});
const notFound=(message:string)=>new Response(JSON.stringify({error:message}),{status:404,headers:{"content-type":"application/json"}});

type ItemInput={id:string;title:string;sku:string;size:string;qty:number;amountCents:number;purchaseCourierCompany:string;purchaseCourierNo:string};
const parseItems=(value:unknown):ItemInput[]=>(Array.isArray(value)?value:[]).slice(0,20).map(item=>{
  const record=item&&typeof item==="object"?item as Record<string,unknown>:{};
  return {id:string(record.id),title:string(record.title),sku:string(record.sku),size:string(record.size),qty:positiveInt(record.qty),amountCents:cents(record.amount),purchaseCourierCompany:string(record.purchaseCourierCompany),purchaseCourierNo:string(record.purchaseCourierNo)};
});
const invalidItems=(items:ItemInput[])=>!items.length||items.some(item=>!item.title||!item.sku||!item.size||item.amountCents<=0||!item.purchaseCourierCompany||!item.purchaseCourierNo);
const buyerEditableStatuses=["待审核","在途","已驳回"] as const;

async function snapshot(user:Awaited<ReturnType<typeof requireAppUser>>){
  const db=getDb();
  const isAdmin=user.role==="admin";
  const rows=isAdmin
    ?await db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt)).limit(500)
    :await db.select().from(purchaseOrders).where(eq(purchaseOrders.purchaserId,user.id)).orderBy(desc(purchaseOrders.createdAt)).limit(300);
  const people=isAdmin?await db.select().from(users).orderBy(users.createdAt):[user];
  const names=new Map(people.map(person=>[person.id,person.name]));
  const phones=new Map(people.map(person=>[person.id,person.phone]));
  const wechatIds=new Map(people.map(person=>[person.id,person.wechatId]));
  const imageRows=rows.length?await db.select({id:orderImages.id,orderId:orderImages.orderId,kind:orderImages.kind,fileName:orderImages.fileName,uploadedBy:orderImages.uploadedBy,createdAt:orderImages.createdAt}).from(orderImages).where(inArray(orderImages.orderId,rows.map(row=>row.id))):[];
  const itemRows=rows.length?await db.select().from(orderItems).where(inArray(orderItems.orderId,rows.map(row=>row.id))):[];
  const orders=rows.map(row=>{
    const rawItems=itemRows.filter(item=>item.orderId===row.id);
    const allShipped=rawItems.length>0&&rawItems.every(item=>item.shippedAt);
    const derived=row.status==="已入库"?(allShipped?"已发货":"待发货"):row.status;
    const status=!isAdmin&&derived==="待发货"?"已入库":derived;
    const items=rawItems.map(item=>({
      id:item.id,title:item.title,sku:item.sku,size:item.size,qty:item.qty,amount:item.amountCents/100,
      purchaseCourierCompany:item.purchaseCourierCompany||row.courierCompany,purchaseCourierNo:item.purchaseCourierNo||row.courierNo,
      shipped:Boolean(item.shippedAt),
      ...(isAdmin?{
        resalePlatform:item.resalePlatform??undefined,resaleNo:item.resaleOrderNo??undefined,
        salePrice:item.salePriceCents==null?undefined:item.salePriceCents/100,
        outboundCompany:item.outboundCompany??undefined,outboundCourier:item.outboundCourierNo??undefined,shippedAt:item.shippedAt??undefined,
      }:{}),
    }));
    return {
      id:row.id,platform:row.platform,platformNo:row.platformOrderNo,courierCompany:row.courierCompany,courierNo:row.courierNo,status,rejectReason:row.rejectReason??undefined,
      purchaserId:row.purchaserId,purchaser:names.get(row.purchaserId)??"采购员",createdAt:row.createdAt,
      settled:row.settled,settledAt:row.settledAt??undefined,receivedAt:row.receivedAt??undefined,
      ...(isAdmin?{purchaserPhone:phones.get(row.purchaserId)??"",purchaserWechatId:wechatIds.get(row.purchaserId)??""}:{}),
      title:items[0]?.title??"",itemCount:items.length,amount:items.reduce((sum,item)=>sum+item.amount,0),items,
      images:imageRows.filter(image=>image.orderId===row.id&&image.kind==="order").map(image=>({id:image.id,url:`/api/files/${image.id}`,fileName:image.fileName,uploadedBy:names.get(image.uploadedBy)??"管理员",createdAt:image.createdAt})),
      settlementProofs:imageRows.filter(image=>image.orderId===row.id&&image.kind==="settlement").map(image=>({id:image.id,url:`/api/files/${image.id}`,fileName:image.fileName,uploadedBy:names.get(image.uploadedBy)??"管理员",createdAt:image.createdAt})),
      ...(isAdmin?{...(row.location?{location:row.location}:{}),settledByName:row.settledBy?names.get(row.settledBy)??"管理员":undefined}:{}),
    };
  });
  let stock:Array<{sku:string;title:string;size:string;count:number;locations:string[]}>=[];
  if(isAdmin){
    const [items,lots]=await Promise.all([db.select().from(inventory),db.select().from(inventoryLots).where(isNull(inventoryLots.shippedAt))]);
    stock=items.map(item=>({sku:item.sku,title:item.title,size:item.size,count:item.quantity,locations:Array.from(new Set(lots.filter(lot=>lot.sku===item.sku&&lot.size===item.size).map(lot=>lot.location)))}));
  }
  return {user,orders,stock,users:people.map(person=>({id:person.id,wechatId:person.wechatId,phone:person.phone,name:person.name,role:person.role,active:person.active,approvalStatus:person.approvalStatus}))};
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
      const platform=string(body.platform),platformNo=string(body.platformNo);
      const items=parseItems(body.items);
      if(!platform)return Response.json({error:"请填写采购渠道"},{status:400});
      if(invalidItems(items))return Response.json({error:"请完整填写每个商品的信息、采购快递公司与采购快递单号"},{status:400});
      const courierCompany=items[0].purchaseCourierCompany,courierNo=items[0].purchaseCourierNo;
      const id=orderId(),timestamp=now();
      await db.transaction(async tx=>{
        await tx.insert(purchaseOrders).values({id,platform,platformOrderNo:platformNo,courierCompany,courierNo,purchaserId:user.id,createdAt:timestamp,updatedAt:timestamp});
        await tx.insert(orderItems).values(items.map(item=>({id:uid("item"),orderId:id,title:item.title,sku:item.sku,size:item.size,qty:item.qty,amountCents:item.amountCents,purchaseCourierCompany:item.purchaseCourierCompany,purchaseCourierNo:item.purchaseCourierNo,createdAt:timestamp,updatedAt:timestamp})));
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"create",entityType:"purchase_order",entityId:id,detailJson:JSON.stringify({itemCount:items.length})});
      });
      return Response.json({data:await snapshot(user),createdOrderId:id},{status:201});
    }

    if(action==="resubmit-order"){
      const id=string(body.orderId),platform=string(body.platform),platformNo=string(body.platformNo);
      const items=parseItems(body.items);
      if(!id||!platform)return Response.json({error:"请填写采购渠道"},{status:400});
      if(invalidItems(items))return Response.json({error:"请完整填写每个商品的信息、采购快递公司与采购快递单号"},{status:400});
      const courierCompany=items[0].purchaseCourierCompany,courierNo=items[0].purchaseCourierNo;
      await db.transaction(async tx=>{
        const [order]=await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id,id)).for("update").limit(1);
        if(!order)throw notFound("订单不存在");
        if(user.role!=="admin"&&order.purchaserId!==user.id)throw conflict("只能修改本人创建的采购订单");
        if(!buyerEditableStatuses.some(status=>status===order.status))throw conflict("订单已入库，采购员不能再修改");
        const nextStatus=order.status==="已驳回"?"待审核":order.status;
        await tx.update(purchaseOrders).set({platform,platformOrderNo:platformNo,courierCompany,courierNo,status:nextStatus,rejectReason:nextStatus==="待审核"?null:order.rejectReason,updatedAt:now()}).where(eq(purchaseOrders.id,id));
        await tx.delete(orderItems).where(eq(orderItems.orderId,id));
        await tx.insert(orderItems).values(items.map(item=>({id:uid("item"),orderId:id,title:item.title,sku:item.sku,size:item.size,qty:item.qty,amountCents:item.amountCents,purchaseCourierCompany:item.purchaseCourierCompany,purchaseCourierNo:item.purchaseCourierNo,createdAt:now(),updatedAt:now()})));
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:order.status==="已驳回"?"resubmit":"buyer_update",entityType:"purchase_order",entityId:id,detailJson:JSON.stringify({previousStatus:order.status,status:nextStatus,itemCount:items.length})});
      });
      return Response.json({data:await snapshot(user),createdOrderId:id});
    }

    if(action==="update-order"){
      requireAdmin(user);
      const id=string(body.orderId),platform=string(body.platform),platformNo=string(body.platformNo);
      const items=parseItems(body.items);
      if(!id||!platform)return Response.json({error:"请填写采购渠道"},{status:400});
      if(invalidItems(items))return Response.json({error:"请完整填写每个商品的信息、采购快递公司与采购快递单号"},{status:400});
      const courierCompany=items[0].purchaseCourierCompany,courierNo=items[0].purchaseCourierNo;
      await db.transaction(async tx=>{
        const [order]=await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id,id)).for("update").limit(1);
        if(!order)throw notFound("订单不存在");
        const purchaserId=body.purchaserId===undefined?order.purchaserId:string(body.purchaserId);
        if(purchaserId!==order.purchaserId){
          const [purchaser]=await tx.select().from(users).where(eq(users.id,purchaserId)).for("share").limit(1);
          if(!purchaser||!purchaser.active||purchaser.approvalStatus!=="approved")throw conflict("请选择已审批通过且启用的采购人");
        }
        if(platformNo){
          const [duplicate]=await tx.select({id:purchaseOrders.id}).from(purchaseOrders).where(and(eq(purchaseOrders.platform,platform),eq(purchaseOrders.platformOrderNo,platformNo),ne(purchaseOrders.id,id),ne(purchaseOrders.status,"已驳回"))).limit(1);
          if(duplicate)throw conflict("该采购渠道下的订单号已有未驳回采购单，请勿重复提交");
        }
        const [existingItems,existingLots]=await Promise.all([
          tx.select().from(orderItems).where(eq(orderItems.orderId,id)).for("update"),
          tx.select().from(inventoryLots).where(eq(inventoryLots.orderId,id)).for("update"),
        ]);
        const timestamp=now(),received=Boolean(order.receivedAt);
        const lotByItem=new Map(existingLots.map(lot=>[lot.itemId,lot]));
        const incomingIds=new Set(items.map(item=>item.id).filter(Boolean));
        for(const old of existingItems){
          if(incomingIds.has(old.id))continue;
          if(old.shippedAt)throw conflict("已发货的商品不能移除");
          const lot=lotByItem.get(old.id);
          if(lot){
            await tx.update(inventory).set({quantity:sql`greatest(0,${inventory.quantity}-${lot.qty})`,updatedAt:timestamp}).where(and(eq(inventory.sku,lot.sku),eq(inventory.size,lot.size)));
            await tx.delete(inventoryLots).where(eq(inventoryLots.itemId,old.id));
          }
          await tx.delete(inventoryMovements).where(and(eq(inventoryMovements.orderId,id),eq(inventoryMovements.sku,old.sku),eq(inventoryMovements.size,old.size)));
          await tx.delete(orderItems).where(eq(orderItems.id,old.id));
        }
        for(const item of items){
          const old=item.id?existingItems.find(row=>row.id===item.id):undefined;
          if(old){
            if(old.shippedAt){
              if(old.sku!==item.sku||old.size!==item.size||old.qty!==item.qty)throw conflict("已发货的商品只能修改金额");
              await tx.update(orderItems).set({title:item.title,amountCents:item.amountCents,purchaseCourierCompany:item.purchaseCourierCompany,purchaseCourierNo:item.purchaseCourierNo,updatedAt:timestamp}).where(eq(orderItems.id,old.id));
              continue;
            }
            await tx.update(orderItems).set({title:item.title,sku:item.sku,size:item.size,qty:item.qty,amountCents:item.amountCents,purchaseCourierCompany:item.purchaseCourierCompany,purchaseCourierNo:item.purchaseCourierNo,updatedAt:timestamp}).where(eq(orderItems.id,old.id));
            const lot=lotByItem.get(old.id);
            if(lot){
              await tx.update(inventory).set({quantity:sql`greatest(0,${inventory.quantity}-${lot.qty})`,updatedAt:timestamp}).where(and(eq(inventory.sku,lot.sku),eq(inventory.size,lot.size)));
              await tx.insert(inventory).values({sku:item.sku,size:item.size,title:item.title,quantity:item.qty,updatedAt:timestamp}).onConflictDoUpdate({target:[inventory.sku,inventory.size],set:{title:item.title,quantity:sql`${inventory.quantity}+${item.qty}`,updatedAt:timestamp}});
              await tx.update(inventoryLots).set({sku:item.sku,size:item.size,qty:item.qty}).where(eq(inventoryLots.itemId,old.id));
              await tx.update(inventoryMovements).set({sku:item.sku,size:item.size,changeQty:item.qty}).where(and(eq(inventoryMovements.orderId,id),eq(inventoryMovements.type,"receive"),eq(inventoryMovements.sku,old.sku),eq(inventoryMovements.size,old.size)));
            }
          }else{
            const itemId=uid("item");
            await tx.insert(orderItems).values({id:itemId,orderId:id,title:item.title,sku:item.sku,size:item.size,qty:item.qty,amountCents:item.amountCents,purchaseCourierCompany:item.purchaseCourierCompany,purchaseCourierNo:item.purchaseCourierNo,createdAt:timestamp,updatedAt:timestamp});
            if(received){
              await tx.insert(inventory).values({sku:item.sku,size:item.size,title:item.title,quantity:item.qty,updatedAt:timestamp}).onConflictDoUpdate({target:[inventory.sku,inventory.size],set:{title:item.title,quantity:sql`${inventory.quantity}+${item.qty}`,updatedAt:timestamp}});
              await tx.insert(inventoryLots).values({itemId,orderId:id,sku:item.sku,size:item.size,qty:item.qty,location:order.location??"",receivedAt:order.receivedAt??timestamp});
              await tx.insert(inventoryMovements).values({id:uid("move"),orderId:id,sku:item.sku,size:item.size,changeQty:item.qty,type:"receive",location:order.location,actorId:user.id,createdAt:timestamp});
            }
          }
        }
        await tx.update(purchaseOrders).set({platform,platformOrderNo:platformNo,courierCompany,courierNo,purchaserId,status:order.status==="已驳回"?"待审核":order.status,rejectReason:order.status==="已驳回"?null:order.rejectReason,updatedAt:timestamp}).where(eq(purchaseOrders.id,id));
        if(purchaserId!==order.purchaserId)await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"change-purchaser",entityType:"purchase_order",entityId:id,detailJson:JSON.stringify({before:{purchaserId:order.purchaserId},after:{purchaserId}}),createdAt:timestamp});
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"update",entityType:"purchase_order",entityId:id,detailJson:JSON.stringify({before:{platform:order.platform,platformNo:order.platformOrderNo,courierCompany:order.courierCompany,courierNo:order.courierNo,items:existingItems.map(item=>({title:item.title,sku:item.sku,size:item.size,qty:item.qty,amountCents:item.amountCents}))},after:{platform,platformNo,courierCompany,courierNo,items:items.map(item=>({title:item.title,sku:item.sku,size:item.size,qty:item.qty,amountCents:item.amountCents}))}}),createdAt:timestamp});
      });
      return Response.json({data:await snapshot(user),createdOrderId:id});
    }

    if(action==="delete-orders"){
      requireAdmin(user);
      const ids=Array.from(new Set((Array.isArray(body.orderIds)?body.orderIds:[]).filter((value):value is string=>typeof value==="string").map(value=>value.trim()).filter(Boolean))).slice(0,100);
      if(!ids.length)return Response.json({error:"请选择要删除的订单"},{status:400});
      const deleted=await db.transaction(async tx=>{
        const orders=await tx.select().from(purchaseOrders).where(inArray(purchaseOrders.id,ids)).for("update");
        if(!orders.length)throw notFound("所选订单不存在或已删除");
        const orderIds=orders.map(order=>order.id),timestamp=now();
        const [lots,images]=await Promise.all([
          tx.select().from(inventoryLots).where(inArray(inventoryLots.orderId,orderIds)),
          tx.select({objectKey:orderImages.objectKey}).from(orderImages).where(inArray(orderImages.orderId,orderIds)),
        ]);
        for(const lot of lots.filter(item=>!item.shippedAt)){
          await tx.update(inventory).set({quantity:sql`greatest(0,${inventory.quantity}-${lot.qty})`,updatedAt:timestamp}).where(and(eq(inventory.sku,lot.sku),eq(inventory.size,lot.size)));
        }
        await tx.delete(inventoryMovements).where(inArray(inventoryMovements.orderId,orderIds));
        await tx.delete(inventoryLots).where(inArray(inventoryLots.orderId,orderIds));
        await tx.delete(orderItems).where(inArray(orderItems.orderId,orderIds));
        await tx.delete(orderImages).where(inArray(orderImages.orderId,orderIds));
        await tx.delete(purchaseOrders).where(inArray(purchaseOrders.id,orderIds));
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"delete_batch",entityType:"purchase_order",entityId:orderIds.join(","),detailJson:JSON.stringify({orderIds,count:orderIds.length}),createdAt:timestamp});
        return {count:orderIds.length,objectKeys:images.map(image=>image.objectKey)};
      });
      await Promise.all(deleted.objectKeys.map(objectKey=>unlink(uploadPath(objectKey)).catch(()=>undefined)));
      return Response.json({data:await snapshot(user),deletedCount:deleted.count});
    }

    if(action==="approve"||action==="reject"){
      requireAdmin(user);const id=string(body.orderId),reason=string(body.reason);
      if(!id)return Response.json({error:"缺少订单 ID"},{status:400});
      if(action==="reject"&&!reason)return Response.json({error:"驳回原因不能为空"},{status:400});
      await db.transaction(async tx=>{
        const [order]=await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id,id)).for("update").limit(1);
        if(!order)throw notFound("订单不存在");
        if(action==="approve"&&order.status!=="待审核")throw conflict("只有待审核订单可以通过审核");
        const timestamp=now();
        if(action==="reject"){
          if(order.settled)throw conflict("订单已结款，不能再驳回");
          if(!["待审核","在途","已入库","待发货"].includes(order.status))throw conflict("当前订单不能驳回");
          const items=await tx.select().from(orderItems).where(eq(orderItems.orderId,id)).for("update");
          if(items.some(item=>item.shippedAt))throw conflict("订单已有商品发货，不能整单驳回");
          const lots=await tx.select().from(inventoryLots).where(eq(inventoryLots.orderId,id)).for("update");
          if(lots.some(lot=>lot.shippedAt))throw conflict("订单已有商品发货，不能整单驳回");
          for(const lot of lots){
            const changed=await tx.update(inventory).set({quantity:sql`${inventory.quantity}-${lot.qty}`,updatedAt:timestamp}).where(and(eq(inventory.sku,lot.sku),eq(inventory.size,lot.size),sql`${inventory.quantity} >= ${lot.qty}`)).returning({sku:inventory.sku});
            if(!changed.length)throw conflict("库存不足以回退，请检查库存后重试");
            await tx.insert(inventoryMovements).values({id:uid("move"),orderId:id,sku:lot.sku,size:lot.size,changeQty:-lot.qty,type:"adjust",location:lot.location,actorId:user.id,createdAt:timestamp});
          }
          await tx.delete(inventoryLots).where(eq(inventoryLots.orderId,id));
        }
        await tx.update(purchaseOrders).set({status:action==="approve"?"在途":"已驳回",rejectReason:action==="reject"?reason:null,auditorId:user.id,...(action==="reject"?{receivedAt:null,location:null}:{}),updatedAt:timestamp}).where(eq(purchaseOrders.id,id));
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action,entityType:"purchase_order",entityId:id,detailJson:JSON.stringify({reason,previousStatus:order.status,previousLocation:order.location}),createdAt:timestamp});
      });
      return Response.json({data:await snapshot(user)});
    }

    if(action==="receive"){
      requireAdmin(user);const id=string(body.orderId),location=string(body.location);
      if(!id||!location)return Response.json({error:"订单与库位不能为空"},{status:400});
      await db.transaction(async tx=>{
        const [order]=await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id,id)).for("update").limit(1);
        if(!order)throw notFound("订单不存在");
        if(order.status!=="在途")throw conflict(order.receivedAt?"该包裹已完成入库，请勿重复操作":"只有在途订单可以入库");
        const items=await tx.select().from(orderItems).where(eq(orderItems.orderId,id)).for("update");
        if(!items.length)throw conflict("订单没有商品，无法入库");
        const timestamp=now();
        await tx.update(purchaseOrders).set({status:"已入库",receivedAt:timestamp,location,updatedAt:timestamp}).where(eq(purchaseOrders.id,id));
        for(const item of items){
          await tx.insert(inventory).values({sku:item.sku,size:item.size,title:item.title,quantity:item.qty,updatedAt:timestamp}).onConflictDoUpdate({target:[inventory.sku,inventory.size],set:{title:item.title,quantity:sql`${inventory.quantity}+${item.qty}`,updatedAt:timestamp}});
          await tx.insert(inventoryLots).values({itemId:item.id,orderId:id,sku:item.sku,size:item.size,qty:item.qty,location,receivedAt:timestamp});
          await tx.insert(inventoryMovements).values({id:uid("move"),orderId:id,sku:item.sku,size:item.size,changeQty:item.qty,type:"receive",location,actorId:user.id,createdAt:timestamp});
        }
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"receive",entityType:"purchase_order",entityId:id,detailJson:JSON.stringify({location,itemCount:items.length}),createdAt:timestamp});
      });
      return Response.json({data:await snapshot(user)});
    }

    if(action==="settle-order"){
      requireAdmin(user);const id=string(body.orderId);
      if(!id)return Response.json({error:"缺少订单 ID"},{status:400});
      await db.transaction(async tx=>{
        const [order]=await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id,id)).for("update").limit(1);
        if(!order)throw notFound("订单不存在");
        if(!order.receivedAt)throw conflict("采购单尚未入库，不能结款");
        if(order.settled)throw conflict("采购单已经完成结款，请勿重复操作");
        const timestamp=now();
        await tx.update(purchaseOrders).set({settled:true,settledAt:timestamp,settledBy:user.id,updatedAt:timestamp}).where(eq(purchaseOrders.id,id));
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"settle",entityType:"purchase_order",entityId:id,detailJson:JSON.stringify({receivedAt:order.receivedAt,shippingIndependent:true}),createdAt:timestamp});
      });
      return Response.json({data:await snapshot(user)});
    }

    if(action==="revert-receive"){
      requireAdmin(user);const id=string(body.orderId);
      if(!id)return Response.json({error:"缺少订单 ID"},{status:400});
      await db.transaction(async tx=>{
        const [order]=await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id,id)).for("update").limit(1);
        if(!order)throw notFound("订单不存在");
        if(order.settled)throw conflict("订单已结款，不能撤销入库");
        if(order.status!=="已入库")throw conflict("只有已入库订单可以退回在途");
        const items=await tx.select().from(orderItems).where(eq(orderItems.orderId,id)).for("update");
        if(items.some(item=>item.shippedAt))throw conflict("订单内已有商品发货，无法退回在途");
        const lots=await tx.select().from(inventoryLots).where(eq(inventoryLots.orderId,id)).for("update");
        const timestamp=now();
        for(const lot of lots){
          await tx.update(inventory).set({quantity:sql`greatest(0,${inventory.quantity}-${lot.qty})`,updatedAt:timestamp}).where(and(eq(inventory.sku,lot.sku),eq(inventory.size,lot.size)));
          await tx.insert(inventoryMovements).values({id:uid("move"),orderId:id,sku:lot.sku,size:lot.size,changeQty:-lot.qty,type:"adjust",location:lot.location,actorId:user.id,createdAt:timestamp});
        }
        await tx.delete(inventoryLots).where(eq(inventoryLots.orderId,id));
        await tx.update(purchaseOrders).set({status:"在途",receivedAt:null,location:null,updatedAt:timestamp}).where(eq(purchaseOrders.id,id));
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"revert_receive",entityType:"purchase_order",entityId:id,detailJson:JSON.stringify({location:order.location,receivedAt:order.receivedAt,revertedItems:lots.length}),createdAt:timestamp});
      });
      return Response.json({data:await snapshot(user)});
    }

    if(action==="ship"){
      requireAdmin(user);const itemId=string(body.itemId),resaleNo=string(body.resaleNo),courier=string(body.courier),company=string(body.company),sale=cents(body.salePrice);
      if(!itemId||!courier||!company)return Response.json({error:"请完整填写发货物流公司和运单号"},{status:400});
      await db.transaction(async tx=>{
        const [target]=await tx.select({orderId:orderItems.orderId}).from(orderItems).where(eq(orderItems.id,itemId)).limit(1);
        if(!target)throw notFound("商品不存在");
        const [order]=await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id,target.orderId)).for("update").limit(1);
        if(!order||order.status!=="已入库")throw conflict("订单未入库，不能发货");
        const [item]=await tx.select().from(orderItems).where(eq(orderItems.id,itemId)).for("update").limit(1);
        if(!item)throw notFound("商品不存在");
        if(item.shippedAt)throw conflict("该商品已发货，请勿重复操作");
        const timestamp=now();
        await tx.update(orderItems).set({resalePlatform:string(body.resalePlatform)||"得物",resaleOrderNo:resaleNo||null,salePriceCents:sale>0?sale:null,outboundCompany:company,outboundCourierNo:courier,shippedAt:timestamp,updatedAt:timestamp}).where(eq(orderItems.id,itemId));
        await tx.update(inventory).set({quantity:sql`greatest(0,${inventory.quantity}-${item.qty})`,updatedAt:timestamp}).where(and(eq(inventory.sku,item.sku),eq(inventory.size,item.size)));
        await tx.update(inventoryLots).set({shippedAt:timestamp}).where(eq(inventoryLots.itemId,itemId));
        await tx.insert(inventoryMovements).values({id:uid("move"),orderId:item.orderId,sku:item.sku,size:item.size,changeQty:-item.qty,type:"ship",location:order.location,actorId:user.id,createdAt:timestamp});
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"ship",entityType:"order_item",entityId:itemId,detailJson:JSON.stringify({orderId:item.orderId,resaleNo,courier,salePriceCents:sale}),createdAt:timestamp});
      });
      return Response.json({data:await snapshot(user)});
    }

    if(action==="update-shipping"){
      requireAdmin(user);const itemId=string(body.itemId),courier=string(body.courier),company=string(body.company),sale=cents(body.salePrice);
      if(!itemId||!courier||!company)return Response.json({error:"请完整填写发货物流公司和运单号"},{status:400});
      await db.transaction(async tx=>{
        const [item]=await tx.select().from(orderItems).where(eq(orderItems.id,itemId)).for("update").limit(1);
        if(!item)throw notFound("商品不存在");
        if(!item.shippedAt)throw conflict("只有已发货商品可以修改发货物流");
        const timestamp=now();
        await tx.update(orderItems).set({salePriceCents:sale>0?sale:null,outboundCompany:company,outboundCourierNo:courier,updatedAt:timestamp}).where(eq(orderItems.id,itemId));
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"update_shipping",entityType:"order_item",entityId:itemId,detailJson:JSON.stringify({orderId:item.orderId,before:{salePriceCents:item.salePriceCents,company:item.outboundCompany,courier:item.outboundCourierNo},after:{salePriceCents:sale>0?sale:null,company,courier}}),createdAt:timestamp});
      });
      return Response.json({data:await snapshot(user)});
    }

    if(action==="batch-ship"){
      requireAdmin(user);
      const shipments=(Array.isArray(body.shipments)?body.shipments:[]).slice(0,100).map(item=>{
        const record=item&&typeof item==="object"?item as Record<string,unknown>:{};
        return {orderId:string(record.orderId),courier:string(record.courier),company:string(record.company)};
      });
      const ids=shipments.map(item=>item.orderId);
      if(!shipments.length||shipments.some(item=>!item.orderId||!item.courier||!item.company)||new Set(ids).size!==ids.length)return Response.json({error:"请为每笔订单完整填写物流公司和发货运单号"},{status:400});
      await db.transaction(async tx=>{
        const orders=await tx.select().from(purchaseOrders).where(inArray(purchaseOrders.id,ids)).for("update");
        if(orders.length!==ids.length)throw notFound("部分订单不存在，请刷新后重试");
        const invalid=orders.find(order=>order.status!=="已入库");
        if(invalid)throw conflict(`订单 ${invalid.id} 当前状态不能发货`);
        const items=await tx.select().from(orderItems).where(inArray(orderItems.orderId,ids)).for("update");
        const timestamp=now(),shipmentMap=new Map(shipments.map(item=>[item.orderId,item]));
        for(const order of orders){
          const shipment=shipmentMap.get(order.id)!;
          const pending=items.filter(item=>item.orderId===order.id&&!item.shippedAt);
          if(!pending.length)throw conflict(`订单 ${order.id} 没有待发货商品`);
          for(const item of pending){
            await tx.update(orderItems).set({outboundCompany:shipment.company,outboundCourierNo:shipment.courier,shippedAt:timestamp,updatedAt:timestamp}).where(eq(orderItems.id,item.id));
            await tx.update(inventory).set({quantity:sql`greatest(0,${inventory.quantity}-${item.qty})`,updatedAt:timestamp}).where(and(eq(inventory.sku,item.sku),eq(inventory.size,item.size)));
            await tx.update(inventoryLots).set({shippedAt:timestamp}).where(eq(inventoryLots.itemId,item.id));
            await tx.insert(inventoryMovements).values({id:uid("move"),orderId:order.id,sku:item.sku,size:item.size,changeQty:-item.qty,type:"ship",location:order.location,actorId:user.id,createdAt:timestamp});
          }
          await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"batch_ship",entityType:"purchase_order",entityId:order.id,detailJson:JSON.stringify({company:shipment.company,courier:shipment.courier,itemCount:pending.length}),createdAt:timestamp});
        }
      });
      return Response.json({data:await snapshot(user),shippedCount:shipments.length});
    }

    if(action==="create-user"){
      requireAdmin(user);const wechatId=string(body.wechatId).toLowerCase(),phone=string(body.phone).replace(/[\s-]/g,""),name=string(body.name),password=string(body.password),role=string(body.role)||"buyer";
      if(!/^[a-z][a-z0-9_-]{5,19}$/.test(wechatId)||!/^1[3-9]\d{9}$/.test(phone)||!name||password.length<8||!["admin","buyer"].includes(role))return Response.json({error:"请填写有效微信号、11 位手机号、姓名和至少 8 位密码"},{status:400});
      const id=uid("usr"),timestamp=now();
      await db.transaction(async tx=>{
        await tx.insert(users).values({id,wechatId,phone,name,passwordHash:await hash(password,12),role:role as "admin"|"buyer",active:true,approvalStatus:"approved",reviewedBy:user.id,reviewedAt:timestamp,createdAt:timestamp,updatedAt:timestamp});
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"create_user",entityType:"user",entityId:id,detailJson:JSON.stringify({wechatId,phone,role}),createdAt:timestamp});
      });
      return Response.json({data:await snapshot(user)},{status:201});
    }

    if(action==="review-user-application"){
      requireAdmin(user);const targetId=string(body.userId),decision=string(body.decision);
      if(!targetId||!["approve","reject"].includes(decision))return Response.json({error:"审批参数错误"},{status:400});
      const timestamp=now(),approvalStatus=decision==="approve"?"approved":"rejected";
      const changed=await db.transaction(async tx=>{
        const [applicant]=await tx.select().from(users).where(eq(users.id,targetId)).for("update").limit(1);
        if(!applicant||applicant.role!=="buyer")throw notFound("采购员申请不存在");
        if(applicant.approvalStatus==="approved")throw conflict("该账号已通过审批");
        if(decision==="reject"&&applicant.approvalStatus!=="pending")throw conflict("该申请已处理");
        const rows=await tx.update(users).set({approvalStatus,active:decision==="approve",reviewedBy:user.id,reviewedAt:timestamp,updatedAt:timestamp}).where(eq(users.id,targetId)).returning({id:users.id});
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:decision==="approve"?"approve_user_application":"reject_user_application",entityType:"user",entityId:targetId,detailJson:JSON.stringify({wechatId:applicant.wechatId,phone:applicant.phone}),createdAt:timestamp});
        return rows;
      });
      if(!changed.length)return Response.json({error:"采购员申请不存在"},{status:404});
      return Response.json({data:await snapshot(user)});
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

    if(action==="delete-user"){
      requireAdmin(user);const targetId=string(body.userId);
      if(!targetId)return Response.json({error:"缺少成员 ID"},{status:400});
      if(targetId===user.id)return Response.json({error:"不能删除自己的账号"},{status:409});
      const deleted=await db.transaction(async tx=>{
        const [target]=await tx.select().from(users).where(eq(users.id,targetId)).for("update").limit(1);
        if(!target)throw notFound("成员不存在");
        if(target.role!=="buyer")throw conflict("只能删除采购员账号，管理员请先调整为采购员");
        const [[orderCount],[imageCount],[auditCount]]=await Promise.all([
          tx.select({count:sql<number>`count(*)::int`}).from(purchaseOrders).where(eq(purchaseOrders.purchaserId,targetId)),
          tx.select({count:sql<number>`count(*)::int`}).from(orderImages).where(eq(orderImages.uploadedBy,targetId)),
          tx.select({count:sql<number>`count(*)::int`}).from(auditLogs).where(eq(auditLogs.actorId,targetId)),
        ]);
        if(orderCount.count>0||imageCount.count>0||auditCount.count>0)throw conflict("该采购员已有订单或操作记录，无法删除；如需禁止登录请使用「停用」");
        const timestamp=now();
        await tx.delete(users).where(eq(users.id,targetId));
        await tx.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"delete_user",entityType:"user",entityId:targetId,detailJson:JSON.stringify({name:target.name,wechatId:target.wechatId,phone:target.phone,approvalStatus:target.approvalStatus}),createdAt:timestamp});
        return target;
      });
      return Response.json({data:await snapshot(user),deletedUserName:deleted.name});
    }

    if(action==="reset-user-password"){
      requireAdmin(user);const targetId=string(body.userId),password=string(body.password);
      if(!targetId)return Response.json({error:"缺少成员 ID"},{status:400});
      if(password.length<8)return Response.json({error:"新密码至少 8 位"},{status:400});
      const timestamp=now();
      const changed=await db.update(users).set({passwordHash:await hash(password,12),updatedAt:timestamp}).where(eq(users.id,targetId)).returning({id:users.id});
      if(!changed.length)return Response.json({error:"成员不存在"},{status:404});
      await db.insert(auditLogs).values({id:uid("audit"),actorId:user.id,action:"reset_password",entityType:"user",entityId:targetId,detailJson:"{}",createdAt:timestamp});
      return Response.json({data:await snapshot(user)});
    }

    return Response.json({error:"不支持的操作"},{status:400});
  }catch(error){return routeError(error);}
}
