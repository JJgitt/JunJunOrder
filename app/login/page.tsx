"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage(){
  const router=useRouter();
  const [error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setError("");setBusy(true);
    const form=new FormData(event.currentTarget);
    try{
      const response=await fetch("/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:form.get("email"),password:form.get("password")})});
      const result=await response.json() as {error?:string};
      if(!response.ok)throw new Error(result.error??"登录失败");
      router.replace("/");
    }catch(reason){setError(reason instanceof Error?reason.message:"登录失败");setBusy(false);}
  }
  return <main className="login-shell"><section className="login-card"><div className="login-brand"><span>骏</span><div><b>骏骏订单</b><small>独立服务器版</small></div></div><div className="login-copy"><p>ORDER OPERATIONS</p><h1>登录管理系统</h1><span>订单、库存、收发货与权限统一管理</span></div><form onSubmit={submit}><label><span>邮箱</span><input name="email" type="email" autoComplete="username" required placeholder="admin@example.com"/></label><label><span>密码</span><input name="password" type="password" autoComplete="current-password" required placeholder="请输入密码"/></label>{error&&<p className="login-error" role="alert">{error}</p>}<button className="primary-button" type="submit" disabled={busy}>{busy?"正在登录…":"登录"}</button></form><p className="login-footnote">账号由管理员创建；初始管理员由服务器启动配置生成。</p></section></main>;
}
