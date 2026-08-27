import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { assertSameOrigin, createSessionToken, routeError, sessionCookie } from "@/lib/auth";

export const dynamic="force-dynamic";

export async function POST(request:Request){
  try{
    assertSameOrigin(request);
    const body=await request.json() as {email?:string;password?:string};
    const email=String(body.email??"").trim().toLowerCase();
    const password=String(body.password??"");
    if(!email||!password)return Response.json({error:"请输入邮箱和密码"},{status:400});
    const [user]=await getDb().select().from(users).where(eq(users.email,email)).limit(1);
    if(!user||!user.active||!(await compare(password,user.passwordHash)))return Response.json({error:"邮箱或密码错误"},{status:401});
    const token=await createSessionToken(user);
    return Response.json({user:{id:user.id,email:user.email,name:user.name,role:user.role,active:user.active}},{headers:{"set-cookie":sessionCookie(token),"cache-control":"no-store"}});
  }catch(error){return routeError(error);}
}
