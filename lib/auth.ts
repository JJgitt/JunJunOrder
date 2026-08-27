import { eq } from "drizzle-orm";
import { getD1, getDb } from "@/db";
import { users } from "@/db/schema";

export type AppUser = { id:string; email:string; name:string; role:"admin"|"buyer"; active:boolean };

function identityFrom(request: Request) {
  const id = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email");
  const encodedName = request.headers.get("oai-authenticated-user-full-name");
  const encoding = request.headers.get("oai-authenticated-user-full-name-encoding");
  if (id && email) {
    let name = email;
    if (encodedName && encoding === "percent-encoded-utf-8") {
      try { name = decodeURIComponent(encodedName); } catch { name = email; }
    }
    return { id, email, name };
  }
  const url = new URL(request.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return { id:"local-dev-admin", email:"admin@local.dev", name:"本地管理员" };
  return null;
}

export async function requireAppUser(request: Request): Promise<AppUser> {
  const identity = identityFrom(request);
  if (!identity) throw new Response(JSON.stringify({ error:"请先登录" }), { status:401, headers:{ "content-type":"application/json" } });
  const d1 = getD1();
  await d1.prepare(`INSERT INTO users (id,email,name,role,active,created_at,updated_at)
    SELECT ?1,?2,?3,CASE WHEN EXISTS(SELECT 1 FROM users) THEN 'buyer' ELSE 'admin' END,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,updated_at=CURRENT_TIMESTAMP`).bind(identity.id,identity.email,identity.name).run();
  const [row] = await getDb().select().from(users).where(eq(users.id, identity.id)).limit(1);
  if (!row || !row.active) throw new Response(JSON.stringify({ error:"账号已停用" }), { status:403, headers:{ "content-type":"application/json" } });
  return { id:row.id,email:row.email,name:row.name,role:row.role,active:row.active };
}

export function requireAdmin(user: AppUser) {
  if (user.role !== "admin") throw new Response(JSON.stringify({ error:"需要管理员权限" }), { status:403, headers:{ "content-type":"application/json" } });
}

export function routeError(error: unknown) {
  if (error instanceof Response) return error;
  const message = error instanceof Error ? error.message : "服务器内部错误";
  const status = message.includes("UNIQUE constraint failed") ? 409 : message.includes("no such table") ? 503 : 500;
  return Response.json({ error: status === 409 ? "该平台订单号已存在" : status === 503 ? "数据库尚未初始化，请先部署迁移" : message }, { status });
}
