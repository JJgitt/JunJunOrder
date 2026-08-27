import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { orderImages, purchaseOrders } from "@/db/schema";
import { requireAppUser, routeError } from "@/lib/auth";
import { uploadPath } from "@/lib/file-storage";

export const dynamic="force-dynamic";
export const runtime="nodejs";

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const user=await requireAppUser(request),{id}=await params,db=getDb();
    const [image]=await db.select().from(orderImages).where(eq(orderImages.id,id)).limit(1);
    if(!image)return new Response("Not found",{status:404});
    const [order]=await db.select().from(purchaseOrders).where(eq(purchaseOrders.id,image.orderId)).limit(1);
    if(!order||(user.role!=="admin"&&order.purchaserId!==user.id))return new Response("Forbidden",{status:403});
    const bytes=await readFile(uploadPath(image.objectKey)).catch(()=>null);
    if(!bytes)return new Response("Not found",{status:404});
    return new Response(bytes,{headers:{"content-type":image.contentType,"content-length":String(bytes.byteLength),"cache-control":"private, max-age=3600","x-content-type-options":"nosniff","content-disposition":`inline; filename*=UTF-8''${encodeURIComponent(image.fileName)}`}});
  }catch(error){return routeError(error);}
}
