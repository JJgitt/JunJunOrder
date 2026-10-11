import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, orderImages, purchaseOrders } from "@/db/schema";
import { assertSameOrigin, requireAppUser, routeError } from "@/lib/auth";
import { imageExtension, uploadPath } from "@/lib/file-storage";
import { orderImageUploadError } from "@/lib/order-image-upload";

export const dynamic="force-dynamic";
export const runtime="nodejs";

export async function POST(request:Request){
  try{
    assertSameOrigin(request);
    const user=await requireAppUser(request),form=await request.formData(),orderId=String(form.get("orderId")??"").trim();
    if(!orderId)return Response.json({error:"缺少订单 ID"},{status:400});
    const db=getDb(),[order]=await db.select().from(purchaseOrders).where(eq(purchaseOrders.id,orderId)).limit(1);
    if(!order)return Response.json({error:"订单不存在"},{status:404});
    if(user.role!=="admin"&&order.purchaserId!==user.id)return Response.json({error:"无权上传此订单的附件"},{status:403});
    const entries=form.getAll("files");
    if(entries.some(value=>!(value instanceof File)))return Response.json({error:"请选择有效的订单图片"},{status:400});
    const files=entries as File[],validationError=orderImageUploadError(files);
    if(validationError)return Response.json({error:validationError},{status:400});
    const writtenPaths:string[]=[];
    let uploaded:{id:string;fileName:string;createdAt:string}[];
    try{
      uploaded=await db.transaction(async tx=>{
        // Serialize against reassignment/deletion and recheck ownership before touching disk.
        const [currentOrder]=await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id,orderId)).for("update").limit(1);
        if(!currentOrder)throw Response.json({error:"订单不存在"},{status:404});
        if(user.role!=="admin"&&currentOrder.purchaserId!==user.id)throw Response.json({error:"无权上传此订单的附件"},{status:403});
        const values=[];
        for(const file of files){
          const id=`img_${crypto.randomUUID()}`,objectKey=`orders/${orderId}/${id}${imageExtension(file.type)}`,target=uploadPath(objectKey);
          const buffer=Buffer.from(await file.arrayBuffer());
          await mkdir(path.dirname(target),{recursive:true});
          // Track only files created by this request, including partially written files.
          const handle=await open(target,"wx");
          writtenPaths.push(target);
          try{await handle.writeFile(buffer);}finally{await handle.close();}
          values.push({id,orderId,kind:"order" as const,objectKey,fileName:file.name,contentType:file.type,sizeBytes:file.size,uploadedBy:user.id});
        }
        const rows=await tx.insert(orderImages).values(values).returning({id:orderImages.id,fileName:orderImages.fileName,createdAt:orderImages.createdAt});
        await tx.insert(auditLogs).values({id:`audit_${crypto.randomUUID()}`,actorId:user.id,action:"append_order_images",entityType:"purchase_order",entityId:orderId,detailJson:JSON.stringify({imageIds:rows.map(row=>row.id),count:rows.length})});
        return rows;
      });
    }catch(error){
      await Promise.all(writtenPaths.map(target=>unlink(target).catch(cleanupError=>console.error("Failed to clean up new order image",cleanupError))));
      throw error;
    }
    return Response.json({imageIds:uploaded.map(row=>row.id),images:uploaded.map(row=>({...row,url:`/api/files/${row.id}`,uploadedBy:user.name}))},{status:201});
  }catch(error){return routeError(error);}
}

export async function GET(request:Request){
  try{
    const user=await requireAppUser(request),orderId=new URL(request.url).searchParams.get("orderId")??"",db=getDb();
    const [order]=await db.select().from(purchaseOrders).where(eq(purchaseOrders.id,orderId)).limit(1);
    if(!order)return Response.json({error:"订单不存在"},{status:404});
    if(user.role!=="admin"&&order.purchaserId!==user.id)return Response.json({error:"无权查看"},{status:403});
    const rows=await db.select({id:orderImages.id,kind:orderImages.kind,fileName:orderImages.fileName,contentType:orderImages.contentType,sizeBytes:orderImages.sizeBytes,createdAt:orderImages.createdAt}).from(orderImages).where(and(eq(orderImages.orderId,orderId)));
    return Response.json({images:rows.map(row=>({...row,url:`/api/files/${row.id}`}))});
  }catch(error){return routeError(error);}
}
