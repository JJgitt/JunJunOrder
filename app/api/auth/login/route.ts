import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { assertSameOrigin, createSessionToken, routeError, sessionCookie } from "@/lib/auth";

export const dynamic="force-dynamic";

export async function POST(request:Request){
  try{
    assertSameOrigin(request);
    const body=await request.json() as {wechatId?:string;password?:string};
    const wechatId=String(body.wechatId??"").trim().toLowerCase();
    const password=String(body.password??"");
    if(!wechatId||!password)return Response.json({error:"请输入微信号和密码"},{status:400});
    const [user]=await getDb().select().from(users).where(eq(users.wechatId,wechatId)).limit(1);
    if(!user||!(await compare(password,user.passwordHash)))return Response.json({error:"微信号或密码错误"},{status:401});
    if(user.approvalStatus==="pending")return Response.json({error:"账号申请正在等待管理员审批，通过后方可登录"},{status:403});
    if(user.approvalStatus==="rejected")return Response.json({error:"账号申请未通过，请联系管理员"},{status:403});
    if(!user.active)return Response.json({error:"账号已停用，请联系管理员"},{status:403});
    const token=await createSessionToken(user);
    return Response.json({user:{id:user.id,wechatId:user.wechatId,phone:user.phone,name:user.name,role:user.role,active:user.active,approvalStatus:user.approvalStatus}},{headers:{"set-cookie":sessionCookie(token),"cache-control":"no-store"}});
  }catch(error){return routeError(error);}
}
