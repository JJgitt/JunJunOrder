import { clearSessionCookie } from "@/lib/auth";

function logout(){return new Response(null,{status:303,headers:{location:"/login","set-cookie":clearSessionCookie(),"cache-control":"no-store"}});}
export async function GET(){return logout();}
export async function POST(){return logout();}
