import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { getDb } from "@/db";
import { users } from "@/db/schema";

export type AppUser = { id:string; wechatId:string; phone:string; name:string; role:"admin"|"buyer"; active:boolean; approvalStatus:"pending"|"approved"|"rejected" };
export const SESSION_COOKIE = "junjun_session";

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error("AUTH_SECRET 必须至少为 32 个字符");
  return new TextEncoder().encode(value);
}

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const item of cookies.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return null;
}

export async function createSessionToken(user: Pick<AppUser, "id"|"wechatId"|"role">) {
  return new SignJWT({ wechatId:user.wechatId, role:user.role })
    .setProtectedHeader({ alg:"HS256", typ:"JWT" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret());
}

export function sessionCookie(token:string) {
  const secure = process.env.COOKIE_SECURE !== "false";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie() {
  const secure = process.env.COOKIE_SECURE !== "false";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function assertSameOrigin(request:Request) {
  const origin=request.headers.get("origin");
  const host=request.headers.get("host");
  if(origin&&host&&new URL(origin).host!==host)throw new Response(JSON.stringify({error:"请求来源无效"}),{status:403,headers:{"content-type":"application/json"}});
}

export async function requireAppUser(request: Request): Promise<AppUser> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) throw new Response(JSON.stringify({ error:"请先登录" }), { status:401, headers:{ "content-type":"application/json" } });
  let userId:string;
  try {
    const verified=await jwtVerify(token,secret(),{algorithms:["HS256"]});
    if(!verified.payload.sub)throw new Error("missing subject");
    userId=verified.payload.sub;
  } catch {
    throw new Response(JSON.stringify({ error:"登录已过期，请重新登录" }), { status:401, headers:{ "content-type":"application/json","set-cookie":clearSessionCookie() } });
  }
  const [row] = await getDb().select().from(users).where(eq(users.id,userId)).limit(1);
  if (!row || !row.active || row.approvalStatus!=="approved") throw new Response(JSON.stringify({ error:"账号不存在、未通过审批或已停用" }), { status:403, headers:{ "content-type":"application/json","set-cookie":clearSessionCookie() } });
  return { id:row.id,wechatId:row.wechatId,phone:row.phone,name:row.name,role:row.role,active:row.active,approvalStatus:row.approvalStatus };
}

export function requireAdmin(user: AppUser) {
  if (user.role !== "admin") throw new Response(JSON.stringify({ error:"需要管理员权限" }), { status:403, headers:{ "content-type":"application/json" } });
}

export function routeError(error: unknown) {
  if (error instanceof Response) return error;
  const dbError=error as {code?:string;cause?:{code?:string}};
  const dbCode=dbError.code??dbError.cause?.code;
  const message = error instanceof Error ? error.message : "服务器内部错误";
  const status = dbCode === "23505" ? 409 : message.includes("DATABASE_URL") || message.includes("connect") ? 503 : 500;
  const safeMessage=status===409?"该微信号、手机号或平台订单号已存在":status===503?"数据库暂时不可用，请联系管理员":process.env.NODE_ENV==="production"?"服务器内部错误":message;
  console.error(error);
  return Response.json({ error:safeMessage }, { status });
}
