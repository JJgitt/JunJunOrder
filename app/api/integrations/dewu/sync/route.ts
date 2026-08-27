import { env } from "cloudflare:workers";
import { requireAdmin, requireAppUser, routeError } from "@/lib/auth";

export const dynamic="force-dynamic";

export async function POST(request:Request){try{requireAdmin(await requireAppUser(request));const config=env as unknown as {DEWU_SYNC_ENDPOINT?:string;DEWU_APP_KEY?:string;DEWU_APP_SECRET?:string};if(!config.DEWU_SYNC_ENDPOINT||!config.DEWU_APP_KEY||!config.DEWU_APP_SECRET)return Response.json({error:"得物开放平台服务端凭证尚未配置"},{status:501});const response=await fetch(config.DEWU_SYNC_ENDPOINT,{method:"POST",headers:{"content-type":"application/json","x-app-key":config.DEWU_APP_KEY,"x-app-secret":config.DEWU_APP_SECRET},body:JSON.stringify({requestedAt:new Date().toISOString()})});if(!response.ok)return Response.json({error:"得物订单同步失败"},{status:502});return Response.json(await response.json());}catch(error){return routeError(error);}}
