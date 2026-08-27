import { assertSameOrigin, requireAdmin, requireAppUser, routeError } from "@/lib/auth";

export const dynamic="force-dynamic";

export async function POST(request:Request){try{assertSameOrigin(request);requireAdmin(await requireAppUser(request));const endpoint=process.env.DEWU_SYNC_ENDPOINT,appKey=process.env.DEWU_APP_KEY,appSecret=process.env.DEWU_APP_SECRET;if(!endpoint||!appKey||!appSecret)return Response.json({error:"得物开放平台服务端凭证尚未配置"},{status:501});const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json","x-app-key":appKey,"x-app-secret":appSecret},body:JSON.stringify({requestedAt:new Date().toISOString()})});if(!response.ok)return Response.json({error:"得物订单同步失败"},{status:502});return Response.json(await response.json());}catch(error){return routeError(error);}}
