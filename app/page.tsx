"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Role = "admin" | "buyer";
type AdminTab = "dashboard" | "stock" | "orders" | "upload" | "profile";
type BuyerTab = "home" | "upload" | "mine";
type OrderStatus = "待审核" | "在途" | "已入库" | "待发货" | "已发货" | "已驳回";
type Overlay = "receipt" | "scan" | "detail" | "reject" | "ship" | null;

type PurchaseOrder = {
  id: string; platform: string; platformNo: string; title: string; sku: string;
  size: string; qty: number; amount: number; courierNo: string; status: OrderStatus;
  purchaser: string; createdAt: string; location?: string; rejectReason?: string;
  resaleNo?: string; salePrice?: number; outboundCourier?: string;
};

type StockItem = { sku: string; title: string; size: string; count: number; locations: string[]; lastSold?: string };
type AppUser = { id:string; email:string; name:string; role:Role; active:boolean };
type Snapshot = { user:AppUser; orders:PurchaseOrder[]; stock:StockItem[]; users:AppUser[] };

const statusTone: Record<OrderStatus, string> = { "待审核":"gray", "在途":"orange", "已入库":"blue", "待发货":"purple", "已发货":"green", "已驳回":"red" };
const money = (value: number) => `¥${value.toLocaleString("zh-CN", { minimumFractionDigits:2 })}`;

export default function Home() {
  const router=useRouter();
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [people, setPeople] = useState<AppUser[]>([]);
  const [adminTab, setAdminTab] = useState<AdminTab>("dashboard");
  const [buyerTab, setBuyerTab] = useState<BuyerTab>("home");
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [stock, setStock] = useState<StockItem[]>([]);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [selectedId, setSelectedId] = useState("");
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");

  const selected = orders.find(order => order.id === selectedId) ?? orders[0];
  const notify = (text: string) => { setToast(text); window.setTimeout(() => setToast(""), 2200); };
  const openOrder = (id: string) => { setSelectedId(id); setOverlay("detail"); };
  const applySnapshot = useCallback((data:Snapshot) => { setCurrentUser(data.user);setPeople(data.users);setOrders(data.orders);setStock(data.stock); },[]);
  const load = useCallback(async() => { setLoading(true);setFatalError("");try{const response=await fetch("/api/app",{cache:"no-store"});if(response.status===401){router.replace("/login");return;}const json=await response.json() as Snapshot&{error?:string};if(!response.ok)throw new Error(json.error||"加载失败");applySnapshot(json);}catch(error){setFatalError(error instanceof Error?error.message:"加载失败");}finally{setLoading(false);}},[applySnapshot,router]);
  useEffect(()=>{
    const timer=window.setTimeout(()=>{void load();},0);
    return()=>window.clearTimeout(timer);
  },[load]);
  async function mutate(action:string,payload:Record<string,unknown>={}) { const response=await fetch("/api/app",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,...payload})});if(response.status===401){router.replace("/login");throw new Error("登录已过期");}const json=await response.json() as {data:Snapshot;createdOrderId?:string;error?:string};if(!response.ok)throw new Error(json.error||"操作失败");applySnapshot(json.data);return json; }
  async function run(action:string,payload:Record<string,unknown>,success:string){try{await mutate(action,payload);setOverlay(null);notify(success);}catch(error){notify(error instanceof Error?error.message:"操作失败");}}
  const approve=(id:string)=>void run("approve",{orderId:id},"订单审核通过，已进入在途状态");
  const reject=(id:string,reason:string)=>void run("reject",{orderId:id,reason},"订单已驳回，采购员将收到提醒");
  const receive=(id:string,location:string)=>void run("receive",{orderId:id,location},"收货入库完成，库存已更新");
  const ship=(id:string,resaleNo:string,salePrice:number,courier:string,company:string)=>void run("ship",{orderId:id,resaleNo,salePrice,courier,company,resalePlatform:"得物"},"发货完成，库存已自动扣减");
  async function upload(order:PurchaseOrder,files:File[]){try{const editing=orders.find(item=>item.id===order.id&&item.status==="已驳回");const result=await mutate(editing?"resubmit-order":"create-order",{...(editing?{orderId:order.id}:{}),platform:order.platform,platformNo:order.platformNo,title:order.title,sku:order.sku,size:order.size,qty:order.qty,amount:order.amount,courierNo:order.courierNo});if(files.length&&result.createdOrderId){const form=new FormData();form.set("orderId",result.createdOrderId);files.forEach(file=>form.append("files",file));const response=await fetch("/api/order-images",{method:"POST",body:form});if(!response.ok){const json=await response.json() as {error?:string};throw new Error(`订单已保存，但图片上传失败：${json.error??"未知错误"}`);}}if(currentUser?.role==="admin")setAdminTab("orders");else setBuyerTab("mine");notify(editing?"订单已修改并重新提交":currentUser?.role==="admin"?"采购订单已创建，可在订单列表继续审核":"订单提交成功，等待管理员审核");}catch(error){notify(error instanceof Error?error.message:"提交失败");}}

  if(loading)return <main className="app-frame system-state"><div className="system-loader"/><h2>正在连接业务数据</h2><p>正在验证登录状态并载入订单、库存与权限。</p></main>;
  if(fatalError||!currentUser)return <main className="app-frame system-state"><div className="system-error">!</div><h2>系统暂时不可用</h2><p>{fatalError||"无法识别当前用户"}</p><button className="primary-button" onClick={()=>void load()}>重新连接</button></main>;
  const role=currentUser.role;

  return <main className="app-frame">
    <AppHeader user={currentUser} page={role === "admin" ? adminTab : buyerTab} />

    <div className="page-stage">
      {role === "admin" && adminTab === "dashboard" && <AdminDashboard orders={orders} stock={stock} onCreate={() => {setSelectedId("");setAdminTab("upload");}} onReceipt={() => setOverlay("receipt")} onOrders={() => setAdminTab("orders")} onStock={() => setAdminTab("stock")} />}
      {role === "admin" && adminTab === "stock" && <StockPage stock={stock} onSuggest={() => notify("已生成 3 条采购建议")} />}
      {role === "admin" && adminTab === "orders" && <AdminOrders orders={orders} onCreate={() => {setSelectedId("");setAdminTab("upload");}} onEdit={(id) => {setSelectedId(id);setAdminTab("upload");}} onOpen={openOrder} onApprove={approve} onReject={(id) => { setSelectedId(id); setOverlay("reject"); }} onShip={(id) => { setSelectedId(id); setOverlay("ship"); }} />}
      {role === "admin" && adminTab === "upload" && <UploadPage mode="admin" editing={orders.find(item=>item.id===selectedId&&item.status==="已驳回")} onCancel={() => setAdminTab("orders")} onSubmit={upload} />}
      {role === "admin" && adminTab === "profile" && <AdminProfile user={currentUser} people={people} onRole={(userId,nextRole)=>void run("set-user-role",{userId,role:nextRole},"用户角色已更新")} onActive={(userId,active)=>void run("set-user-active",{userId,active},active?"账号已启用":"账号已停用")} onCreate={(member)=>void run("create-user",member,"成员账号已创建")} onNotify={notify} />}

      {role === "buyer" && buyerTab === "home" && <BuyerHome buyerName={currentUser.name} orders={orders} onUpload={() => {setSelectedId("");setBuyerTab("upload");}} onMine={() => setBuyerTab("mine")} onEdit={(id) => { setSelectedId(id); setBuyerTab("upload"); }} />}
      {role === "buyer" && buyerTab === "upload" && <UploadPage mode="buyer" editing={orders.find(item=>item.id===selectedId&&item.status==="已驳回")} onSubmit={upload} />}
      {role === "buyer" && buyerTab === "mine" && <BuyerOrders orders={orders} onOpen={openOrder} />}
    </div>

    {role === "admin" ? <AdminNav active={adminTab} onChange={setAdminTab} onScan={() => setOverlay("scan")} /> : <BuyerNav active={buyerTab} onChange={setBuyerTab} />}

    {overlay === "receipt" && <ReceiptSheet orders={orders} onClose={() => setOverlay(null)} onReceive={receive} onManual={() => setOverlay("scan")} onNotify={notify} />}
    {overlay === "scan" && <ScanSheet orders={orders} onClose={() => setOverlay(null)} onReceive={receive} onNotify={notify} />}
    {overlay === "detail" && selected && <OrderDetail order={selected} onClose={() => setOverlay(null)} onApprove={() => approve(selected.id)} onReject={() => setOverlay("reject")} onShip={() => setOverlay("ship")} />}
    {overlay === "reject" && selected && <RejectSheet order={selected} onClose={() => setOverlay(null)} onSubmit={reject} />}
    {overlay === "ship" && selected && <ShipSheet order={selected} onClose={() => setOverlay(null)} onSubmit={ship} />}
    {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
  </main>;
}

function AppHeader({ user, page }: { user:AppUser; page:string }) {
  const labels: Record<string,string> = { dashboard:"管理看板", stock:"库存管理", orders:"订单管理", profile:"我的", home:"骏骏订单", upload:"采购订单录入", mine:"我的订单" };
  return <header className="app-header"><div className="logo">J</div><div className="header-copy"><h1>{labels[page]}</h1><span>{user.role === "admin" ? "多渠道采购转卖 · 管理员" : `采购员 · ${user.name}`}</span></div><div className="identity-pill"><b>{user.name.slice(0,1)}</b><span>{user.email}</span></div></header>;
}

function AdminDashboard({ orders, stock, onCreate, onReceipt, onOrders, onStock }: { orders:PurchaseOrder[]; stock:StockItem[]; onCreate:() => void; onReceipt:() => void; onOrders:() => void; onStock:() => void }) {
  const pending = orders.filter(o => o.status === "待审核").length;
  const transit = orders.filter(o => o.status === "在途").length;
  const shipping = orders.filter(o => o.status === "待发货").length;
  const inToday = orders.filter(o => o.status === "已入库").length;
  const purchase = orders.reduce((sum,o) => sum + o.amount, 0);
  const sales = orders.reduce((sum,o) => sum + (o.salePrice ?? 0), 0);
  return <section className="dashboard-page enter">
    <div className="date-row"><div><span>8月24日 · 周一</span><h2>下午好，管理员</h2></div><button aria-label="通知">🔔<i /></button></div>
    <div className="stat-grid"><button onClick={onOrders}><b>{pending}</b><span>待审核</span><em>需处理</em></button><button onClick={onReceipt}><b>{transit}</b><span>在途</span><em>待收货</em></button><button onClick={onOrders}><b>{shipping}</b><span>待发货</span><em>已售出</em></button><button><b>{inToday}</b><span>今日入库</span><em>较昨日 +2</em></button></div>
    <button className="admin-create-entry" onClick={onCreate}><i>＋</i><span><b>新增采购订单</b><small>管理员可直接录入采购与物流信息</small></span><em>立即创建 ›</em></button>
    <div className="receipt-hero"><div className="receipt-icon">📷</div><div><span>推荐收货方式</span><h3>拍照识别快递面单</h3><p>自动识别单号，反查货品、订单与采购员</p></div><button onClick={onReceipt}>开始识别</button></div>
    <SectionHead title="待办事项" note={`${pending + transit + shipping} 项待处理`} />
    <div className="task-card"><Task icon="📦" tone="green" title={`${transit} 笔在途待收货`} note="按快递单号自动关联采购订单" action="拍照识别" onClick={onReceipt} /><Task icon="✓" tone="orange" title={`${pending} 笔新订单待审核`} note="最早一笔已等待 42 分钟" action="去审核" onClick={onOrders} /><Task icon="🚚" tone="purple" title={`${shipping} 笔已售出待发货`} note="请及时填写快递单号" action="去发货" onClick={onOrders} /><Task icon="!" tone="blue" title={`${stock.filter(s => s.count <= 2).length} 个 SKU 库存偏低`} note="建议生成补货清单" action="查看" onClick={onStock} /></div>
    <SectionHead title="本月概览" note="截至今日" />
    <div className="finance-card"><div><span>采购总额</span><b>{money(purchase)}</b></div><div><span>销售总额</span><b>{money(sales)}</b></div><div className="profit"><span>毛利润（估）</span><b>{money(Math.max(0, sales - orders.filter(o => o.salePrice).reduce((s,o) => s + o.amount,0)))}</b></div></div>
  </section>;
}

function SectionHead({ title, note }: { title:string; note:string }) { return <div className="section-head"><h3>{title}</h3><span>{note}</span></div>; }
function Task({ icon,tone,title,note,action,onClick }: { icon:string;tone:string;title:string;note:string;action:string;onClick:() => void }) { return <button className="task-row" onClick={onClick}><i className={tone}>{icon}</i><span><b>{title}</b><small>{note}</small></span><em>{action} ›</em></button>; }

function StockPage({ stock, onSuggest }: { stock:StockItem[]; onSuggest:() => void }) {
  const [query,setQuery] = useState(""); const [filter,setFilter] = useState("全部");
  const visible = stock.filter(item => { const tone = item.count === 0 ? "缺货" : item.count <= 2 ? "偏低" : "充足"; return (filter === "全部" || filter === tone) && `${item.sku}${item.title}${item.size}`.toLowerCase().includes(query.toLowerCase()); });
  return <section className="enter"><Search value={query} onChange={setQuery} placeholder="搜索货号 / 商品名 / 尺码" /><div className="chip-row">{["全部","充足","偏低","缺货"].map(v => <button key={v} className={filter === v ? "active" : ""} onClick={() => setFilter(v)}>{v}</button>)}</div><div className="stock-overview"><div><span>在库总数</span><b>{stock.reduce((s,i) => s+i.count,0)}</b></div><div><span>SKU 数</span><b>{stock.length}</b></div><div><span>库存预警</span><b className="danger-number">{stock.filter(s => s.count <= 2).length}</b></div></div><SectionHead title="SKU 库存" note={`${visible.length} 条结果`} /><div className="sku-list">{visible.map(item => { const tone = item.count === 0 ? "red" : item.count <= 2 ? "orange" : "green"; const label = item.count === 0 ? "缺货" : item.count <= 2 ? "偏低" : "充足"; return <article key={`${item.sku}${item.size}`}><div className="product-monogram">{item.title.slice(0,2)}</div><div className="sku-main"><div><h4>{item.sku} · {item.title}</h4><Badge tone={tone}>{label}</Badge></div><p>{item.size}码 · 库存 <b>{item.count}</b> 件</p><small>{item.locations.length ? `库位 ${item.locations.join(" / ")}` : `最近售出 ${item.lastSold}`}</small></div>{item.count === 0 && <button onClick={onSuggest}>采购建议</button>}</article>})}</div></section>;
}

function AdminOrders({ orders,onCreate,onEdit,onOpen,onApprove,onReject,onShip }: { orders:PurchaseOrder[];onCreate:()=>void;onEdit:(id:string)=>void;onOpen:(id:string)=>void;onApprove:(id:string)=>void;onReject:(id:string)=>void;onShip:(id:string)=>void }) {
  const [query,setQuery] = useState(""); const [status,setStatus] = useState("全部"); const [platform,setPlatform] = useState("全部渠道"); const [buyer,setBuyer] = useState("全部采购员");
  const visible = useMemo(() => orders.filter(order => (status === "全部" || order.status === status) && (platform === "全部渠道" || order.platform === platform) && (buyer === "全部采购员" || order.purchaser === buyer) && `${order.id}${order.platformNo}${order.title}${order.sku}`.toLowerCase().includes(query.toLowerCase())), [orders,query,status,platform,buyer]);
  return <section className="enter"><button className="admin-order-create" onClick={onCreate}><span><b>＋ 新增采购订单</b><small>管理员代录订单，保存后进入统一审核流程</small></span><em>去创建 ›</em></button><Search value={query} onChange={setQuery} placeholder="搜索单号 / 货号 / 商品名" /><div className="chip-row scroll">{["全部","待审核","在途","已入库","待发货","已发货","已驳回"].map(v => <button key={v} className={status === v ? "active" : ""} onClick={() => setStatus(v)}>{v}</button>)}</div><div className="select-row"><select value={platform} onChange={e => setPlatform(e.target.value)}><option>全部渠道</option><option>京东</option><option>淘宝</option><option>拼多多</option></select><select value={buyer} onChange={e => setBuyer(e.target.value)}><option>全部采购员</option>{Array.from(new Set(orders.map(order=>order.purchaser))).map(name=><option key={name}>{name}</option>)}</select><select aria-label="日期"><option>近30天</option><option>近7天</option><option>今天</option></select></div><SectionHead title="采购订单" note={`${visible.length} 笔`} /><div className="order-list">{visible.map(order => <OrderCard key={order.id} order={order} onOpen={() => onOpen(order.id)} actions={order.status === "待审核" ? <><button className="danger-ghost" onClick={() => onReject(order.id)}>驳回</button><button className="small-primary" onClick={() => onApprove(order.id)}>✓ 通过</button></> : order.status === "已驳回" ? <button className="small-primary" onClick={() => onEdit(order.id)}>修改重提</button> : order.status === "待发货" ? <button className="small-primary purple-action" onClick={() => onShip(order.id)}>去发货</button> : undefined} />)}</div></section>;
}

function OrderCard({ order,onOpen,actions }: { order:PurchaseOrder;onOpen:()=>void;actions?:React.ReactNode }) { return <article className={`order-card edge-${statusTone[order.status]}`}><button className="order-main" onClick={onOpen}><div className="order-top"><h4>{order.title} · {order.size}码</h4><Badge tone={statusTone[order.status]}>{order.status}</Badge></div><div className="order-meta"><span>{order.platform} · {order.purchaser}上传</span><b>{money(order.amount)}</b></div><div className="order-meta secondary"><span>{order.platformNo}</span><time>{order.createdAt}</time></div>{order.rejectReason && <p className="reject-note">原因：{order.rejectReason}</p>}</button>{actions && <div className="order-actions">{actions}</div>}</article>; }

function BuyerHome({ buyerName,orders,onUpload,onMine,onEdit }: { buyerName:string;orders:PurchaseOrder[];onUpload:()=>void;onMine:()=>void;onEdit:(id:string)=>void }) {
  const rejected=orders.find(o=>o.status==="已驳回"); const count=(status:OrderStatus)=>orders.filter(o=>o.status===status).length;
  return <section className="enter buyer-home">
    <div className="buyer-welcome"><span>采购员 · {buyerName}</span><h2>今天也要买到好价 👋</h2><p>订单及时上报，仓库收货更高效</p></div>
    <div className="buyer-stats"><button onClick={onMine}><b>{count("待审核")}</b><span>待审核</span></button><button onClick={onMine}><b>{count("在途")}</b><span>在途</span></button><button onClick={onMine}><b>{count("已入库")}</b><span>已入库</span></button><button onClick={onMine}><b>{orders.length}</b><span>本月单数</span></button></div>
    {rejected&&<div className="rejected-alert"><div><span>!</span><b>有订单被驳回</b></div><h4>{rejected.title} · {rejected.size}码</h4><p>{rejected.rejectReason}</p><button onClick={()=>onEdit(rejected.id)}>修改后重新提交</button></div>}
    <SectionHead title="快捷操作" note="10 秒完成上报"/><div className="buyer-quick"><button className="upload-quick" onClick={onUpload}><i>＋</i><span><b>上传采购订单</b><small>填写渠道、商品与物流信息</small></span><em>›</em></button><button onClick={onMine}><i>▤</i><span><b>查看我的订单</b><small>跟踪审核、在途与入库状态</small></span><em>›</em></button></div>
    <SectionHead title="最近订单" note="查看全部"/><div className="order-list compact">{orders.slice(0,2).map(order=><OrderCard key={order.id} order={order} onOpen={onMine}/>)}</div>
  </section>;
}

function UploadPage({mode,editing,onCancel,onSubmit}:{mode:"admin"|"buyer";editing?:PurchaseOrder;onCancel?:()=>void;onSubmit:(order:PurchaseOrder,files:File[])=>Promise<void>}){
  const [platform,setPlatform]=useState(editing?.platform??"京东"),[platformNo,setPlatformNo]=useState(editing?.platformNo??""),[title,setTitle]=useState(editing?.title??""),[sku,setSku]=useState(editing?.sku??""),[size,setSize]=useState(editing?.size??"");
  const [qty,setQty]=useState(editing?.qty??1),[amount,setAmount]=useState(editing?.amount?.toString()??""),[courier,setCourier]=useState(editing?.courierNo??""),[files,setFiles]=useState<File[]>([]),[submitting,setSubmitting]=useState(false);
  async function submit(event:FormEvent){event.preventDefault();if(!platformNo||!title||!sku||!size||!amount)return;setSubmitting(true);try{await onSubmit({id:editing?.id??"",platform,platformNo,title,sku,size,qty,amount:Number(amount),courierNo:courier,status:"待审核",purchaser:"",createdAt:""},files);}finally{setSubmitting(false);}}
  return <section className="enter upload-page"><div className="form-intro"><div><span>{editing?"驳回订单修改":mode==="admin"?"ADMIN PURCHASE":"NEW PURCHASE"}</span><h2>{editing?"修改并重新提交":mode==="admin"?"新增采购订单":"上报采购订单"}</h2><p>{mode==="admin"?"以管理员身份录入，订单与附件将持久化保存到服务器。":"订单与附件将持久化保存到服务器，提交后可跨设备查看。"}</p></div>{onCancel&&<button className="form-back-button" type="button" onClick={onCancel}>返回订单</button>}</div>{editing?.rejectReason&&<div className="inline-warning"><b>驳回原因</b><span>{editing.rejectReason}</span></div>}<form className="purchase-form" onSubmit={submit}><div className="field-grid"><label><span>采购渠道 *</span><select value={platform} onChange={e=>setPlatform(e.target.value)}><option>京东</option><option>拼多多</option><option>淘宝</option><option>唯品会</option><option>其他</option></select></label><label><span>平台订单号 *</span><input value={platformNo} onChange={e=>setPlatformNo(e.target.value)} placeholder="请输入订单号"/></label></div><label><span>商品名称 *</span><input value={title} onChange={e=>setTitle(e.target.value)} placeholder="如 乔丹 DUNK LOW 熊猫"/></label><div className="field-grid"><label><span>货号 *</span><input value={sku} onChange={e=>setSku(e.target.value)} placeholder="DD1391-100"/></label><label><span>尺码 *</span><input value={size} onChange={e=>setSize(e.target.value)} placeholder="42 / 41.5"/></label></div><div className="field-grid"><label><span>数量 *</span><input type="number" min="1" value={qty} onChange={e=>setQty(Number(e.target.value))}/></label><label><span>实付金额 *</span><div className="money-input"><i>¥</i><input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></div></label></div><label><span>快递单号 <em>建议必填</em></span><input value={courier} onChange={e=>setCourier(e.target.value)} placeholder="粘贴物流单号，方便仓库识别收货"/></label><label className="upload-zone"><input type="file" accept="image/*" multiple onChange={e=>setFiles(Array.from(e.target.files??[]).slice(0,3))}/><i>＋</i><b>{files.length?`已选择 ${files.length} 张截图`:"上传订单截图"}</b><span>持久化保存，最多 3 张、单张不超过 5MB</span></label><button className="primary-button" disabled={submitting} type="submit">{submitting?"正在保存…":editing?"重新提交审核":mode==="admin"?"创建采购订单":"提交订单"}</button><p className="form-footnote">平台与订单号组合唯一，系统会自动阻止重复上报</p></form></section>;
}

function BuyerOrders({ orders,onOpen }: { orders:PurchaseOrder[];onOpen:(id:string)=>void }) { const [status,setStatus] = useState("全部"); const [query,setQuery] = useState(""); const visible = orders.filter(o => (status === "全部" || o.status === status) && `${o.title}${o.sku}${o.platformNo}`.toLowerCase().includes(query.toLowerCase())); return <section className="enter"><Search value={query} onChange={setQuery} placeholder="搜索商品 / 订单号" /><div className="chip-row scroll">{["全部","待审核","在途","已入库","待发货","已发货"].map(v => <button key={v} className={status === v ? "active" : ""} onClick={() => setStatus(v)}>{v}</button>)}</div><SectionHead title="我的采购订单" note={`${visible.length} 笔`} /><div className="order-list">{visible.map(order => <OrderCard key={order.id} order={order} onOpen={() => onOpen(order.id)} />)}</div></section>; }

function AdminProfile({user,people,onRole,onActive,onCreate,onNotify}:{user:AppUser;people:AppUser[];onRole:(id:string,role:Role)=>void;onActive:(id:string,active:boolean)=>void;onCreate:(member:Record<string,unknown>)=>void;onNotify:(text:string)=>void}){
  const [showCreate,setShowCreate]=useState(false);
  function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const data=new FormData(event.currentTarget);onCreate({name:String(data.get("name")??""),email:String(data.get("email")??""),password:String(data.get("password")??""),role:String(data.get("role")??"buyer")});event.currentTarget.reset();setShowCreate(false);}
  return <section className="enter profile-page">
    <div className="profile-card"><div className="avatar">{user.name.slice(0,1)}</div><div><h2>{user.name}</h2><span>{user.email}</span></div><Badge tone="purple">管理员</Badge></div>
    <SectionHead title="成员与权限" note={`${people.length} 人`}/>
    <button className="member-create-button" onClick={()=>setShowCreate(value=>!value)}>＋ 创建成员账号</button>
    {showCreate&&<form className="member-create-form" onSubmit={submit}><input name="name" required placeholder="成员姓名"/><input name="email" type="email" required placeholder="登录邮箱"/><input name="password" type="password" required minLength={8} placeholder="初始密码（至少 8 位）"/><select name="role" defaultValue="buyer"><option value="buyer">采购员</option><option value="admin">管理员</option></select><button className="primary-button" type="submit">创建账号</button></form>}
    <div className="member-list">{people.map(person=><div key={person.id} className={!person.active?"member-disabled":""}><span><b>{person.name}</b><small>{person.email}</small></span><select value={person.role} disabled={person.id===user.id||!person.active} onChange={e=>onRole(person.id,e.target.value as Role)}><option value="buyer">采购员</option><option value="admin">管理员</option></select>{person.id!==user.id&&<button className="member-state-button" onClick={()=>onActive(person.id,!person.active)}>{person.active?"停用":"启用"}</button>}</div>)}</div>
    <SectionHead title="系统能力" note="独立部署"/><div className="profile-menu"><button onClick={()=>onNotify("利润数据由已发货订单实时计算")}><i>📈</i><span>利润统计</span><small>实时</small><em>›</em></button><a href="/api/export"><i>📤</i><span>导出订单数据</span><small>CSV</small><em>›</em></a><button onClick={()=>onNotify("平台适配器需在服务器环境变量中配置凭证")}><i>🔗</i><span>外部平台连接</span><small>服务端配置</small><em>›</em></button></div>
    <a className="logout" href="/api/auth/logout">退出登录</a><p className="version">骏骏订单 v2.0 · 独立服务器版</p>
  </section>;
}

function ReceiptSheet({ orders,onClose,onReceive,onManual,onNotify }: { orders:PurchaseOrder[];onClose:()=>void;onReceive:(id:string,loc:string)=>void;onManual:()=>void;onNotify:(t:string)=>void }) {
  const [stage,setStage]=useState<"capture"|"result">("capture"),[courier,setCourier]=useState(""),[location,setLocation]=useState(""),[busy,setBusy]=useState(false); const match=orders.find(order=>order.courierNo===courier&&order.status==="在途");
  async function recognize(file?:File){if(!file)return;setBusy(true);try{const form=new FormData();form.set("image",file);const response=await fetch("/api/receipt/ocr",{method:"POST",body:form});const json=await response.json() as {courierNo:string;error?:string};if(!response.ok)throw new Error(json.error||"识别失败");setCourier(json.courierNo);setStage("result");onNotify("面单识别完成");}catch(error){onNotify(error instanceof Error?error.message:"识别失败");}finally{setBusy(false);}}
  if(stage==="capture")return <Modal title="拍照识别收货" subtitle="OCR RECEIPT" onClose={onClose}><label className="camera-zone"><input type="file" accept="image/*" capture="environment" disabled={busy} onChange={e=>void recognize(e.target.files?.[0])}/><i>📷</i><b>{busy?"正在安全识别…":"对准快递面单拍摄"}</b><span>图片仅发送到已配置的服务端 OCR 接口</span></label><label className="secondary-upload"><input type="file" accept="image/*" disabled={busy} onChange={e=>void recognize(e.target.files?.[0])}/>从相册选择</label><button className="text-button" onClick={onManual}>或手动输入快递单号查询</button></Modal>;
  return <Modal title="识别结果" subtitle="MATCH RESULT" onClose={onClose}><div className="recognized-card"><div><b>📷 面单已识别</b><Badge tone={match?"green":"orange"}>{match?"识别成功":"识别完成"}</Badge></div><label><span>快递单号</span><input value={courier} onChange={e=>setCourier(e.target.value)}/></label></div>{match?<div className="match-card"><h3>✓ 关联到 1 笔采购订单</h3><KeyValue label="货品" value={`${match.title} ${match.size}码`}/><KeyValue label="货号 / 尺码" value={`${match.sku} / ${match.size}`}/><KeyValue label="采购订单号" value={match.id}/><KeyValue label="渠道" value={`${match.platform} · ${match.platformNo}`}/><KeyValue label="采购员 / 时间" value={`${match.purchaser} · ${match.createdAt}`}/><KeyValue label="采购金额" value={money(match.amount)}/><label className="location-field"><span>库位（必填）</span><input value={location} onChange={e=>setLocation(e.target.value)} placeholder="如 A-02-5"/></label><button className="primary-button" onClick={()=>location&&onReceive(match.id,location)}>核对无误，确认入库</button></div>:<Unmatched orders={orders} courier={courier} onBind={id=>{const order=orders.find(item=>item.id===id);if(order){setCourier(order.courierNo||courier);onNotify("已绑定候选订单");}}} onAbnormal={()=>onNotify("已标记为异常包裹")}/>}</Modal>;
}

function Unmatched({ orders,courier,onBind,onAbnormal }: { orders:PurchaseOrder[];courier:string;onBind:(id:string)=>void;onAbnormal:()=>void }) { const candidates = orders.filter(o => o.status === "在途").slice(0,2); return <><div className="unmatched"><h3>! 未找到关联采购订单</h3><p>可能原因：采购员未填快递单号，或单号识别有误。</p></div><div className="candidate-card"><h3>尾号 {courier.slice(-4)} 的在途订单</h3>{candidates.map(o => <div key={o.id}><span><b>{o.title} {o.size}码</b><small>{o.platform} · {o.purchaser} · {money(o.amount)}</small></span><button onClick={() => onBind(o.id)}>绑定此单</button></div>)}</div><button className="secondary-button" onClick={onAbnormal}>标记为异常包裹</button></>; }

function ScanSheet({ orders,onClose,onReceive,onNotify }: { orders:PurchaseOrder[];onClose:()=>void;onReceive:(id:string,loc:string)=>void;onNotify:(t:string)=>void }) { const [value,setValue] = useState(""); const [location,setLocation] = useState(""); const match = orders.find(o => o.status === "在途" && (o.courierNo.includes(value) || o.id.includes(value) || o.sku.toLowerCase().includes(value.toLowerCase())) && value.length >= 4); return <Modal title="扫码 / 手输入库" subtitle="QUICK RECEIPT" onClose={onClose}><div className="scanner-box"><div className="scan-beam" /><i>⌗</i><b>对准包裹条码</b><span>扫码枪输入后将自动匹配</span></div><label className="modal-field"><span>订单号 / 快递单号 / 货号后四位</span><input value={value} onChange={e => setValue(e.target.value)} placeholder="请输入至少 4 位" /></label>{match && <div className="match-card compact-match"><h3>匹配到 1 笔在途订单</h3><KeyValue label="商品" value={`${match.title} ${match.size}码`} /><KeyValue label="渠道" value={`${match.platform} · ${match.platformNo}`} /><KeyValue label="采购员" value={match.purchaser} /><label className="location-field"><span>库位（必填）</span><input value={location} onChange={e => setLocation(e.target.value)} placeholder="如 A-02-5" /></label><button className="primary-button" onClick={() => location && onReceive(match.id,location)}>确认入库</button></div>}{value.length >= 4 && !match && <div className="inline-warning"><b>未匹配到在途订单</b><span>请检查输入，或使用拍照识别功能。</span></div>}<button className="text-button" onClick={() => onNotify("扫码枪已进入等待状态")}>连接扫码枪</button></Modal>; }

function OrderDetail({ order,onClose,onApprove,onReject,onShip }: { order:PurchaseOrder;onClose:()=>void;onApprove:()=>void;onReject:()=>void;onShip:()=>void }) { return <Modal title="订单详情" subtitle={order.id} onClose={onClose}><div className={`detail-card edge-${statusTone[order.status]}`}><div className="detail-title"><h3>{order.title} · {order.size}码</h3><Badge tone={statusTone[order.status]}>{order.status}</Badge></div><KeyValue label="采购渠道" value={order.platform} /><KeyValue label="平台单号" value={order.platformNo} /><KeyValue label="货号 / 尺码" value={`${order.sku} / ${order.size}`} /><KeyValue label="采购金额" value={money(order.amount)} /><KeyValue label="采购员" value={`${order.purchaser} · ${order.createdAt}`} /><KeyValue label="快递单号" value={order.courierNo || "未填写"} />{order.location && <KeyValue label="库位" value={order.location} />}{order.resaleNo && <KeyValue label="得物单号" value={order.resaleNo} />}{order.salePrice && <KeyValue label="售价" value={money(order.salePrice)} highlight />}</div><div className="timeline-card"><h3>流转记录</h3><ol><li><b>{order.createdAt}</b><span>{order.purchaser}上传订单</span></li>{order.status !== "待审核" && order.status !== "已驳回" && <li><b>08-24 15:01</b><span>管理员审核通过</span></li>}{order.location && <li><b>08-24 16:12</b><span>收货入库 · {order.location}</span></li>}{order.resaleNo && <li><b>08-24 17:40</b><span>得物平台售出</span></li>}</ol></div>{order.status === "待审核" && <div className="dual-actions"><button className="secondary-danger" onClick={onReject}>驳回</button><button className="primary-button" onClick={onApprove}>审核通过</button></div>}{order.status === "待发货" && <button className="primary-button" onClick={onShip}>🚚 填写快递单号并发货</button>}</Modal>; }

function RejectSheet({ order,onClose,onSubmit }: { order:PurchaseOrder;onClose:()=>void;onSubmit:(id:string,reason:string)=>void }) { const [reason,setReason] = useState(""); return <Modal title="驳回订单" subtitle={order.id} onClose={onClose}><div className="modal-product"><b>{order.title} · {order.size}码</b><span>{order.platform} · {money(order.amount)}</span></div><label className="modal-field"><span>驳回原因（必填）</span><textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="请说明需要采购员修改的内容" /></label><div className="reason-chips">{["平台单号有误","商品信息不完整","采购价格异常"].map(v => <button key={v} onClick={() => setReason(v)}>{v}</button>)}</div><button className="primary-button danger-button" disabled={!reason} onClick={() => onSubmit(order.id,reason)}>确认驳回</button></Modal>; }

function ShipSheet({order,onClose,onSubmit}:{order:PurchaseOrder;onClose:()=>void;onSubmit:(id:string,resale:string,price:number,courier:string,company:string)=>void}){
  const [resale,setResale]=useState(order.resaleNo??""),[price,setPrice]=useState(order.salePrice?.toString()??""),[company,setCompany]=useState("顺丰速运"),[courier,setCourier]=useState("");
  return <Modal title="出库发货" subtitle={order.id} onClose={onClose}><div className="modal-product"><b>{order.title} · {order.size}码</b><span>库位 {order.location} · 当前采购价 {money(order.amount)}</span></div><div className="field-grid"><label className="modal-field"><span>二手平台</span><select><option>得物</option><option>闲鱼</option><option>其他</option></select></label><label className="modal-field"><span>二手平台单号</span><input value={resale} onChange={e=>setResale(e.target.value)}/></label></div><label className="modal-field"><span>成交售价</span><input inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)} placeholder="0.00"/></label><div className="field-grid"><label className="modal-field"><span>快递公司</span><select value={company} onChange={e=>setCompany(e.target.value)}><option>顺丰速运</option><option>京东物流</option><option>中通快递</option></select></label><label className="modal-field"><span>发货单号</span><input value={courier} onChange={e=>setCourier(e.target.value)} placeholder="请输入"/></label></div><div className="profit-preview"><span>预计单笔毛利</span><b>{money(Math.max(0,Number(price||0)-order.amount))}</b></div><button className="primary-button" disabled={!resale||!price||!courier} onClick={()=>onSubmit(order.id,resale,Number(price),courier,company)}>确认发货并扣减库存</button></Modal>;
}

function Search({ value,onChange,placeholder }: { value:string;onChange:(v:string)=>void;placeholder:string }) { return <label className="search-box"><i>⌕</i><input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />{value && <button aria-label="清空" onClick={() => onChange("")}>×</button>}</label>; }
function Badge({ tone,children }: { tone:string;children:React.ReactNode }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
function KeyValue({ label,value,highlight=false }: { label:string;value:string;highlight?:boolean }) { return <div className="key-value"><span>{label}</span><b className={highlight ? "highlight" : ""}>{value}</b></div>; }
function Modal({ title,subtitle,onClose,children }: { title:string;subtitle:string;onClose:()=>void;children:React.ReactNode }) { return <div className="modal-backdrop"><section className="modal-sheet" role="dialog" aria-modal="true" aria-label={title}><div className="sheet-handle"/><header><div><span>{subtitle}</span><h2>{title}</h2></div><button aria-label="关闭" onClick={onClose}>×</button></header>{children}</section></div>; }

function AdminNav({ active,onChange,onScan }: { active:AdminTab;onChange:(v:AdminTab)=>void;onScan:()=>void }) { const left:[AdminTab,string,string][] = [["dashboard","▦","看板"],["stock","◫","库存"]]; const right:[AdminTab,string,string][] = [["orders","▤","订单"],["profile","○","我的"]]; return <nav className="bottom-nav">{left.map(([id,icon,label]) => <button key={id} className={active === id ? "active" : ""} onClick={() => onChange(id)}><i>{icon}</i>{label}</button>)}<button className="central-scan" aria-label="扫码入库" onClick={onScan}><i>⌗</i><span>入库</span></button>{right.map(([id,icon,label]) => <button key={id} className={active === id ? "active" : ""} onClick={() => onChange(id)}><i>{icon}</i>{label}</button>)}</nav>; }
function BuyerNav({ active,onChange }: { active:BuyerTab;onChange:(v:BuyerTab)=>void }) { return <nav className="bottom-nav buyer-nav"><button className={active === "home" ? "active" : ""} onClick={() => onChange("home")}><i>⌂</i>首页</button><button className={`buyer-upload ${active === "upload" ? "active" : ""}`} onClick={() => onChange("upload")}><i>＋</i>上传</button><button className={active === "mine" ? "active" : ""} onClick={() => onChange("mine")}><i>▤</i>我的订单</button></nav>; }
