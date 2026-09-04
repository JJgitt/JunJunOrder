import { hash } from "bcryptjs";
import { eq, or } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { assertSameOrigin, routeError } from "@/lib/auth";

export const dynamic="force-dynamic";
export const runtime="nodejs";

const string=(value:unknown)=>typeof value==="string"?value.trim():"";

export async function POST(request:Request){
  try{
    assertSameOrigin(request);
    const body=await request.json() as {name?:unknown;wechatId?:unknown;phone?:unknown;password?:unknown};
    const name=string(body.name),wechatId=string(body.wechatId).toLowerCase(),phone=string(body.phone).replace(/[\s-]/g,""),password=String(body.password??"");
    if(name.length<2)return Response.json({error:"姓名至少填写 2 个字符"},{status:400});
    if(!/^[a-z][a-z0-9_-]{5,19}$/.test(wechatId))return Response.json({error:"微信号需为 6-20 位，以字母开头，可包含字母、数字、下划线或减号"},{status:400});
    if(!/^1[3-9]\d{9}$/.test(phone))return Response.json({error:"请填写有效的 11 位手机号"},{status:400});
    if(password.length<8)return Response.json({error:"密码至少 8 位"},{status:400});

    const db=getDb();
    const [existing]=await db.select({id:users.id}).from(users).where(or(eq(users.wechatId,wechatId),eq(users.phone,phone))).limit(1);
    if(existing)return Response.json({error:"该微信号或手机号已注册或提交过申请"},{status:409});

    const id=`usr_${crypto.randomUUID()}`,timestamp=new Date().toISOString();
    await db.insert(users).values({
      id,wechatId,phone,name,passwordHash:await hash(password,12),role:"buyer",active:false,
      approvalStatus:"pending",createdAt:timestamp,updatedAt:timestamp,
    });
    return Response.json({message:"申请已提交，请等待管理员审批"},{status:201,headers:{"cache-control":"no-store"}});
  }catch(error){return routeError(error);}
}
