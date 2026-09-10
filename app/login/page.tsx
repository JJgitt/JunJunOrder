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
      const response=await fetch("/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({wechatId:form.get("wechatId"),password:form.get("password")})});
      const result=await response.json() as {error?:string};
      if(!response.ok)throw new Error(result.error??"登录失败");
      router.replace("/");
    }catch(reason){setError(reason instanceof Error?reason.message:"登录失败");setBusy(false);}
  }
  return <main className="login-shell"><section className="login-card"><div className="login-brand"><span>鸿</span><div><b>鸿运采购</b><small>独立服务器版</small></div></div><div className="login-copy"><p>ORDER OPERATIONS</p><h1>登录管理系统</h1><span>订单、库存、收发货与权限统一管理</span></div><form onSubmit={submit}><label><span>微信号</span><input name="wechatId" autoComplete="username" required placeholder="请输入微信号"/></label><label><span>密码</span><input name="password" type="password" autoComplete="current-password" required placeholder="请输入密码"/></label>{error&&<p className="login-error" role="alert">{error}</p>}<button className="primary-button" type="submit" disabled={busy}>{busy?"正在登录…":"登录"}</button></form><div className="login-apply"><span>还没有采购员账号？</span><a className="register-entry" href="/register"><i>＋</i><span><b>申请采购员账号</b><small>填写资料，管理员审批后即可登录</small></span><em>›</em></a></div><p className="login-footnote">自主申请需经管理员审批，通过后方可登录。</p></section></main>;
}
