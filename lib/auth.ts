import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { getDb } from "@/db";
import { users } from "@/db/schema";

export type AppUser = { id:string; email:string; name:string; role:"admin"|"buyer"; active:boolean };
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

export async function createSessionToken(user: Pick<AppUser, "id"|"email"|"role">) {
  return new SignJWT({ email:user.email, role:user.role })
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
  if (!row || !row.active) throw new Response(JSON.stringify({ error:"账号不存在或已停用" }), { status:403, headers:{ "content-type":"application/json","set-cookie":clearSessionCookie() } });
  return { id:row.id,email:row.email,name:row.name,role:row.role,active:row.active };
}

export function requireAdmin(user: AppUser) {
  if (user.role !== "admin") throw new Response(JSON.stringify({ error:"需要管理员权限" }), { status:403, headers:{ "content-type":"application/json" } });
}

export function routeError(error: unknown) {
  if (error instanceof Response) return error;
  const dbError=error as {code?:string};
  const message = error instanceof Error ? error.message : "服务器内部错误";
  const status = dbError.code === "23505" ? 409 : message.includes("DATABASE_URL") || message.includes("connect") ? 503 : 500;
  const safeMessage=status===409?"该邮箱或平台订单号已存在":status===503?"数据库暂时不可用，请联系管理员":process.env.NODE_ENV==="production"?"服务器内部错误":message;
  console.error(error);
  return Response.json({ error:safeMessage }, { status });
}
