import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { orderImages, purchaseOrders } from "@/db/schema";
import { assertSameOrigin, requireAppUser, routeError } from "@/lib/auth";
import { imageExtension, uploadPath } from "@/lib/file-storage";

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
    const files=form.getAll("files").filter((value):value is File=>value instanceof File).slice(0,3);
    if(!files.length)return Response.json({error:"请选择图片"},{status:400});
    const uploaded:string[]=[];
    for(const file of files){
      const extension=imageExtension(file.type);
      if(!extension||file.size>5*1024*1024)throw new Error("仅支持 5MB 以内的 JPG、PNG、WebP、GIF 或 HEIC 图片");
      const id=`img_${crypto.randomUUID()}`,objectKey=`orders/${orderId}/${id}${extension}`,target=uploadPath(objectKey);
      await mkdir(path.dirname(target),{recursive:true});
      await writeFile(target,Buffer.from(await file.arrayBuffer()),{flag:"wx"});
      try{await db.insert(orderImages).values({id,orderId,objectKey,fileName:file.name,contentType:file.type,sizeBytes:file.size,uploadedBy:user.id});uploaded.push(id);}
      catch(error){await unlink(target).catch(()=>undefined);throw error;}
    }
    return Response.json({imageIds:uploaded},{status:201});
  }catch(error){return routeError(error);}
}

export async function GET(request:Request){
  try{
    const user=await requireAppUser(request),orderId=new URL(request.url).searchParams.get("orderId")??"",db=getDb();
    const [order]=await db.select().from(purchaseOrders).where(eq(purchaseOrders.id,orderId)).limit(1);
    if(!order)return Response.json({error:"订单不存在"},{status:404});
    if(user.role!=="admin"&&order.purchaserId!==user.id)return Response.json({error:"无权查看"},{status:403});
    const rows=await db.select({id:orderImages.id,fileName:orderImages.fileName,contentType:orderImages.contentType,sizeBytes:orderImages.sizeBytes,createdAt:orderImages.createdAt}).from(orderImages).where(and(eq(orderImages.orderId,orderId)));
    return Response.json({images:rows.map(row=>({...row,url:`/api/files/${row.id}`}))});
  }catch(error){return routeError(error);}
}
