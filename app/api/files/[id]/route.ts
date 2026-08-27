import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { orderImages, purchaseOrders } from "@/db/schema";
import { requireAppUser, routeError } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
  try{
    const user=await requireAppUser(request); const {id}=await params; const db=getDb();
    const [image]=await db.select().from(orderImages).where(eq(orderImages.id,id)).limit(1); if(!image)return new Response("Not found",{status:404});
    const [order]=await db.select().from(purchaseOrders).where(eq(purchaseOrders.id,image.orderId)).limit(1);
    if(!order||(user.role!=="admin"&&order.purchaserId!==user.id))return new Response("Forbidden",{status:403});
    const bucket=(env as unknown as {FILES:R2Bucket}).FILES; const object=await bucket.get(image.objectKey); if(!object)return new Response("Not found",{status:404});
    return new Response(object.body,{headers:{"content-type":image.contentType,"cache-control":"private, max-age=3600","content-disposition":`inline; filename*=UTF-8''${encodeURIComponent(image.fileName)}`}});
  }catch(error){return routeError(error);}
}
