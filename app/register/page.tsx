"use client";

import { FormEvent, useState } from "react";

export default function RegisterPage(){
  const [error,setError]=useState(""),[success,setSuccess]=useState(false),[busy,setBusy]=useState(false);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setError("");
    const form=new FormData(event.currentTarget),password=String(form.get("password")??""),confirm=String(form.get("confirm")??"");
    if(password!==confirm){setError("两次输入的密码不一致");return;}
    setBusy(true);
    try{
      const response=await fetch("/api/auth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:form.get("name"),phone:form.get("phone"),wechatId:form.get("wechatId"),password})});
      const result=await response.json() as {error?:string};
      if(!response.ok)throw new Error(result.error??"申请提交失败");
      setSuccess(true);
    }catch(reason){setError(reason instanceof Error?reason.message:"申请提交失败");}
    finally{setBusy(false);}
  }
  return <main className="login-shell"><section className="login-card register-card"><div className="login-brand"><span>骏</span><div><b>骏骏订单</b><small>采购员入驻</small></div></div>{success?<div className="register-success"><i>✓</i><h1>申请已提交</h1><p>管理员审批通过后即可使用微信号和密码登录。</p><a className="primary-link" href="/login">返回登录</a></div>:<><div className="login-copy register-copy"><p>BUYER APPLICATION</p><h1>申请采购员账号</h1><span>请填写真实信息，便于管理员审核</span></div><form onSubmit={submit}><label><span>姓名</span><input name="name" required minLength={2} maxLength={30} autoComplete="name" placeholder="请输入真实姓名"/></label><label><span>手机号</span><input name="phone" type="tel" required inputMode="numeric" pattern="1[3-9][0-9]{9}" maxLength={11} autoComplete="tel" placeholder="请输入 11 位手机号"/></label><label><span>微信号</span><input name="wechatId" required minLength={6} maxLength={20} pattern="[A-Za-z][A-Za-z0-9_-]{5,19}" autoComplete="username" placeholder="6-20 位，以字母开头"/></label><label><span>设置密码</span><input name="password" type="password" required minLength={8} autoComplete="new-password" placeholder="至少 8 位"/></label><label><span>确认密码</span><input name="confirm" type="password" required minLength={8} autoComplete="new-password" placeholder="再次输入密码"/></label>{error&&<p className="login-error" role="alert">{error}</p>}<button className="primary-button" type="submit" disabled={busy}>{busy?"正在提交…":"提交申请"}</button></form><a className="login-back-link" href="/login">已有账号，返回登录</a><p className="login-footnote">申请账号固定为采购员角色，审批通过前无法登录。</p></>}</section></main>;
}
