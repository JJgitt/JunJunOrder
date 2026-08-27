import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { orderImages, purchaseOrders } from "@/db/schema";
import { requireAppUser, routeError } from "@/lib/auth";

export const dynamic = "force-dynamic";
const filesBucket = () => (env as unknown as { FILES:R2Bucket }).FILES;

export async function POST(request:Request) {
  try {
    const user=await requireAppUser(request); const form=await request.formData(); const orderId=String(form.get("orderId")??"").trim();
    if(!orderId)return Response.json({error:"缺少订单 ID"},{status:400});
    const db=getDb(); const [order]=await db.select().from(purchaseOrders).where(eq(purchaseOrders.id,orderId)).limit(1);
    if(!order)return Response.json({error:"订单不存在"},{status:404});
    if(user.role!=="admin"&&order.purchaserId!==user.id)return Response.json({error:"无权上传此订单的附件"},{status:403});
    const files=form.getAll("files").filter((value):value is File=>value instanceof File).slice(0,3);
    if(!files.length)return Response.json({error:"请选择图片"},{status:400});
    const bucket=filesBucket(); const uploaded:string[]=[];
    for(const file of files){
      if(!file.type.startsWith("image/")||file.size>5*1024*1024)throw new Error("仅支持 5MB 以内的图片");
      const id=`img_${crypto.randomUUID()}`; const safeName=file.name.replace(/[^a-zA-Z0-9._-]/g,"_"); const key=`orders/${orderId}/${id}-${safeName}`;
      await bucket.put(key,file.stream(),{httpMetadata:{contentType:file.type}});
      try{await db.insert(orderImages).values({id,orderId,objectKey:key,fileName:file.name,contentType:file.type,sizeBytes:file.size,uploadedBy:user.id});uploaded.push(id);}catch(error){await bucket.delete(key);throw error;}
    }
    return Response.json({imageIds:uploaded},{status:201});
  }catch(error){return routeError(error);}
}

export async function GET(request:Request) {
  try{
    const user=await requireAppUser(request); const orderId=new URL(request.url).searchParams.get("orderId")??""; const db=getDb();
    const [order]=await db.select().from(purchaseOrders).where(eq(purchaseOrders.id,orderId)).limit(1);
    if(!order)return Response.json({error:"订单不存在"},{status:404});
    if(user.role!=="admin"&&order.purchaserId!==user.id)return Response.json({error:"无权查看"},{status:403});
    const rows=await db.select({id:orderImages.id,fileName:orderImages.fileName,contentType:orderImages.contentType,sizeBytes:orderImages.sizeBytes,createdAt:orderImages.createdAt}).from(orderImages).where(and(eq(orderImages.orderId,orderId)));
    return Response.json({images:rows.map(row=>({...row,url:`/api/files/${row.id}`}))});
  }catch(error){return routeError(error);}
}
