"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";

type Role = "admin" | "buyer";
type AdminTab = "dashboard" | "stock" | "orders" | "upload" | "profile";
type BuyerTab = "home" | "upload" | "mine";
type OrderStatus = "待审核" | "在途" | "已入库" | "待发货" | "已发货" | "已驳回";
type Overlay = "receipt" | "scan" | "manual-receive" | "revert-receive" | "detail" | "reject" | "ship" | null;
type OrderImage = { id:string; url:string; fileName:string; uploadedBy:string; createdAt:string };

type OrderItem = {
  id: string; title: string; sku: string; size: string; qty: number; amount: number;
  shipped?: boolean; resalePlatform?: string; resaleNo?: string; salePrice?: number; outboundCompany?: string; outboundCourier?: string;
};

type PurchaseOrder = {
  id: string; platform: string; platformNo: string; courierCompany: string; courierNo: string; status: OrderStatus;
  purchaser: string; purchaserPhone?:string; purchaserWechatId?:string; createdAt: string; location?: string; receivedAt?: string; rejectReason?: string;
  title: string; itemCount: number; amount: number; items: OrderItem[];
  images: OrderImage[];
};

type StockItem = { sku: string; title: string; size: string; count: number; locations: string[]; lastSold?: string };
type ApprovalStatus = "pending" | "approved" | "rejected";
type AppUser = { id:string; wechatId:string; phone:string; name:string; role:Role; active:boolean; approvalStatus:ApprovalStatus };
type Snapshot = { user:AppUser; orders:PurchaseOrder[]; stock:StockItem[]; users:AppUser[] };

const statusTone: Record<OrderStatus, string> = { "待审核":"gray", "在途":"orange", "已入库":"purple", "待发货":"purple", "已发货":"green", "已驳回":"red" };
const readyToShip = (status:OrderStatus) => status === "已入库" || status === "待发货";
const statusLabel = (status:OrderStatus) => readyToShip(status) ? "待发货" : status;
const money = (value: number) => `¥${value.toLocaleString("zh-CN", { minimumFractionDigits:2 })}`;
const courierCompanies = ["顺丰速运","京东物流","中通快递","圆通速递","申通快递","韵达快递","极兔速递","邮政EMS"] as const;
const purchaseChannels = ["京东","淘宝","抖音","唯品会","拼多多","其他"] as const;
const courierCompanyChoice = (value?:string) => value && courierCompanies.some(company=>company===value) ? value : value ? "其他" : "顺丰速运";

async function copyText(value:string){
  if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(value);return;}
  const textarea=document.createElement("textarea");
  textarea.value=value;textarea.setAttribute("readonly","");textarea.style.position="fixed";textarea.style.opacity="0";
  document.body.appendChild(textarea);textarea.select();
  const copied=document.execCommand("copy");textarea.remove();
  if(!copied)throw new Error("复制失败");
}

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
  const [selectedItemId, setSelectedItemId] = useState("");
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
  async function mutate(action:string,payload:Record<string,unknown>={}) { const response=await fetch("/api/app",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,...payload})});if(response.status===401){router.replace("/login");throw new Error("登录已过期");}const json=await response.json() as {data:Snapshot;createdOrderId?:string;deletedCount?:number;shippedCount?:number;error?:string};if(!response.ok)throw new Error(json.error||"操作失败");applySnapshot(json.data);return json; }
  async function uploadOrderFiles(orderId:string,files:File[]){const form=new FormData();form.set("orderId",orderId);files.forEach(file=>form.append("files",file));const response=await fetch("/api/order-images",{method:"POST",body:form});if(!response.ok){const json=await response.json() as {error?:string};throw new Error(json.error??"图片上传失败");}}
  async function run(action:string,payload:Record<string,unknown>,success:string){try{await mutate(action,payload);setOverlay(null);notify(success);}catch(error){notify(error instanceof Error?error.message:"操作失败");}}
  const approve=(id:string)=>void run("approve",{orderId:id},"订单审核通过，已进入在途状态");
  const reject=(id:string,reason:string)=>void run("reject",{orderId:id,reason},"订单已驳回，采购员将收到提醒");
  async function receive(id:string,location:string,files:File[]=[]){try{await mutate("receive",{orderId:id,location});}catch(error){notify(error instanceof Error?error.message:"入库失败");return;}if(files.length){try{await uploadOrderFiles(id,files);await load();}catch(error){setOverlay(null);notify(`入库成功，但截图上传失败：${error instanceof Error?error.message:"未知错误"}`);return;}}setOverlay(null);notify(files.length?"收货入库完成，截图已保存":"收货入库完成，库存已更新");}
  const ship=(itemId:string,shipped:boolean,resaleNo:string,salePrice:number,courier:string,company:string,resalePlatform:string)=>void run(shipped?"update-shipping":"ship",{itemId,resaleNo,salePrice,courier,company,resalePlatform},shipped?"预估售价与发货物流已更新":"发货完成，库存已自动扣减");
  async function batchShip(shipments:Array<{orderId:string;courier:string;company:string}>){try{const result=await mutate("batch-ship",{shipments});notify(`已完成 ${result.shippedCount??shipments.length} 笔订单发货`);return true;}catch(error){notify(error instanceof Error?error.message:"批量发货失败");return false;}}
  async function deleteOrders(ids:string[]){try{const result=await mutate("delete-orders",{orderIds:ids});notify(`已删除 ${result.deletedCount??ids.length} 笔订单`);return true;}catch(error){notify(error instanceof Error?error.message:"删除失败");return false;}}
  async function revertReceive(id:string){try{await mutate("revert-receive",{orderId:id});setOverlay(null);notify("订单已退回在途，库存已回滚");return true;}catch(error){notify(error instanceof Error?error.message:"退回在途失败");return false;}}
  async function resetPassword(userId:string,password:string){try{await mutate("reset-user-password",{userId,password});notify("成员密码已重置");return true;}catch(error){notify(error instanceof Error?error.message:"重置密码失败");return false;}}
  async function upload(order:PurchaseOrder,files:File[]){try{const editing=orders.find(item=>item.id===order.id);const action=editing?(currentUser?.role==="admin"?"update-order":"resubmit-order"):"create-order";const result=await mutate(action,{...(editing?{orderId:order.id}:{}),platform:order.platform,platformNo:order.platformNo,courierCompany:order.courierCompany,courierNo:order.courierNo,items:order.items.map(item=>({id:item.id,title:item.title,sku:item.sku,size:item.size,qty:item.qty,amount:item.amount}))});if(files.length&&result.createdOrderId){try{await uploadOrderFiles(result.createdOrderId,files);await load();}catch(error){throw new Error(`订单已保存，但图片上传失败：${error instanceof Error?error.message:"未知错误"}`);}}if(currentUser?.role==="admin")setAdminTab("orders");else setBuyerTab("mine");notify(editing?(currentUser?.role==="admin"?"订单信息已更新":"订单已修改并重新提交"):currentUser?.role==="admin"?"采购订单已创建，可在订单列表继续审核":"订单提交成功，等待管理员审核");}catch(error){notify(error instanceof Error?error.message:"提交失败");}}

  if(loading)return <main className="app-frame system-state"><div className="system-loader"/><h2>正在连接业务数据</h2><p>正在验证登录状态并载入订单、库存与权限。</p></main>;
  if(fatalError||!currentUser)return <main className="app-frame system-state"><div className="system-error">!</div><h2>系统暂时不可用</h2><p>{fatalError||"无法识别当前用户"}</p><button className="primary-button" onClick={()=>void load()}>重新连接</button></main>;
  const role=currentUser.role;

  return <main className="app-frame">
    <AppHeader user={currentUser} page={role === "admin" ? adminTab : buyerTab} />

    <div className="page-stage">
      {role === "admin" && adminTab === "dashboard" && <AdminDashboard orders={orders} stock={stock} onCreate={() => {setSelectedId("");setAdminTab("upload");}} onReceipt={() => setOverlay("receipt")} onOrders={() => setAdminTab("orders")} onStock={() => setAdminTab("stock")} />}
      {role === "admin" && adminTab === "stock" && <StockPage stock={stock} onSuggest={() => notify("已生成 3 条采购建议")} />}
      {role === "admin" && adminTab === "orders" && <AdminOrders orders={orders} onCreate={() => {setSelectedId("");setAdminTab("upload");}} onEdit={(id) => {setSelectedId(id);setAdminTab("upload");}} onDelete={deleteOrders} onBatchShip={batchShip} onOpen={openOrder} onApprove={approve} onReceive={(id) => {setSelectedId(id);setOverlay("manual-receive");}} onReject={(id) => { setSelectedId(id); setOverlay("reject"); }} onShip={(id) => { setSelectedId(id); setOverlay("detail"); }} />}
      {role === "admin" && adminTab === "upload" && <UploadPage mode="admin" editing={orders.find(item=>item.id===selectedId)} onCancel={() => setAdminTab("orders")} onSubmit={upload} />}
      {role === "admin" && adminTab === "profile" && <AdminProfile user={currentUser} people={people} onRole={(userId,nextRole)=>void run("set-user-role",{userId,role:nextRole},"用户角色已更新")} onActive={(userId,active)=>void run("set-user-active",{userId,active},active?"账号已启用":"账号已停用")} onCreate={(member)=>void run("create-user",member,"成员账号已创建")} onReview={(userId,decision)=>void run("review-user-application",{userId,decision},decision==="approve"?"采购员申请已通过":"采购员申请已拒绝")} onResetPassword={resetPassword} onNotify={notify} />}

      {role === "buyer" && buyerTab === "home" && <BuyerHome buyerName={currentUser.name} orders={orders} onUpload={() => {setSelectedId("");setBuyerTab("upload");}} onMine={() => setBuyerTab("mine")} onEdit={(id) => { setSelectedId(id); setBuyerTab("upload"); }} />}
      {role === "buyer" && buyerTab === "upload" && <UploadPage mode="buyer" editing={orders.find(item=>item.id===selectedId&&item.status==="已驳回")} onSubmit={upload} />}
      {role === "buyer" && buyerTab === "mine" && <BuyerOrders orders={orders} onOpen={openOrder} />}
    </div>

    {role === "admin" ? <AdminNav active={adminTab} onChange={setAdminTab} onScan={() => setOverlay("scan")} /> : <BuyerNav active={buyerTab} onChange={setBuyerTab} />}

    {role === "admin" && overlay === "receipt" && <ReceiptSheet orders={orders} onClose={() => setOverlay(null)} onReceive={receive} onManual={() => setOverlay("scan")} onNotify={notify} />}
    {role === "admin" && overlay === "scan" && <ScanSheet orders={orders} onClose={() => setOverlay(null)} onReceive={receive} onNotify={notify} />}
    {role === "admin" && overlay === "manual-receive" && selected && <ManualReceiveSheet order={selected} onClose={() => setOverlay(null)} onSubmit={receive} />}
    {overlay === "detail" && selected && <OrderDetail order={selected} canManage={role === "admin"} showLocation={role === "admin"} onClose={() => setOverlay(null)} onApprove={() => approve(selected.id)} onReceive={() => setOverlay("manual-receive")} onRevertReceive={() => setOverlay("revert-receive")} onReject={() => setOverlay("reject")} onShipItem={(itemId) => { setSelectedItemId(itemId); setOverlay("ship"); }} />}
    {role === "admin" && overlay === "revert-receive" && selected && <RevertReceiveSheet order={selected} onClose={() => setOverlay(null)} onSubmit={revertReceive} />}
    {role === "admin" && overlay === "reject" && selected && <RejectSheet order={selected} onClose={() => setOverlay(null)} onSubmit={reject} />}
    {role === "admin" && overlay === "ship" && selected && selected.items.length > 0 && <ShipSheet order={selected} item={selected.items.find(item => item.id === selectedItemId) ?? selected.items[0]} onClose={() => setOverlay(null)} onSubmit={ship} />}
    {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
  </main>;
}

function AppHeader({ user, page }: { user:AppUser; page:string }) {
  const labels: Record<string,string> = { dashboard:"管理看板", stock:"库存管理", orders:"订单管理", profile:"我的", home:"骏骏订单", upload:"采购订单录入", mine:"我的订单" };
  return <header className="app-header"><div className="logo">J</div><div className="header-copy"><h1>{labels[page]}</h1><span>{user.role === "admin" ? "多渠道采购转卖 · 管理员" : `采购员 · ${user.name}`}</span></div><div className="identity-pill"><b>{user.name.slice(0,1)}</b><span>{user.wechatId}</span><a className="identity-logout" href="/api/auth/logout">退出</a></div></header>;
}

function AdminDashboard({ orders, stock, onCreate, onReceipt, onOrders, onStock }: { orders:PurchaseOrder[]; stock:StockItem[]; onCreate:() => void; onReceipt:() => void; onOrders:() => void; onStock:() => void }) {
  const pending = orders.filter(o => o.status === "待审核").length;
  const transit = orders.filter(o => o.status === "在途").length;
  const shipping = orders.filter(o => readyToShip(o.status)).length;
  const inToday = orders.filter(o => o.receivedAt).length;
  const purchase = orders.reduce((sum,o) => sum + o.amount, 0);
  const sales = orders.reduce((sum,o) => sum + o.items.reduce((s,i) => s + (i.salePrice ?? 0), 0), 0);
  return <section className="dashboard-page enter">
    <div className="date-row"><div><span>8月24日 · 周一</span><h2>下午好，管理员</h2></div><button aria-label="通知">🔔<i /></button></div>
    <div className="stat-grid"><button onClick={onOrders}><b>{pending}</b><span>待审核</span><em>需处理</em></button><button onClick={onReceipt}><b>{transit}</b><span>在途</span><em>待收货</em></button><button onClick={onOrders}><b>{shipping}</b><span>待发货</span><em>更新信息</em></button><button><b>{inToday}</b><span>今日入库</span><em>较昨日 +2</em></button></div>
    <button className="admin-create-entry" onClick={onCreate}><i>＋</i><span><b>新增采购订单</b><small>管理员可直接录入采购与物流信息</small></span><em>立即创建 ›</em></button>
    <div className="receipt-hero"><div className="receipt-icon">📷</div><div><span>推荐收货方式</span><h3>拍照识别快递面单</h3><p>自动识别单号，反查货品、订单与采购员</p></div><button onClick={onReceipt}>开始识别</button></div>
    <SectionHead title="待办事项" note={`${pending + transit + shipping} 项待处理`} />
    <div className="task-card"><Task icon="📦" tone="green" title={`${transit} 笔在途待收货`} note="按快递单号自动关联采购订单" action="拍照识别" onClick={onReceipt} /><Task icon="✓" tone="orange" title={`${pending} 笔新订单待审核`} note="最早一笔已等待 42 分钟" action="去审核" onClick={onOrders} /><Task icon="🚚" tone="purple" title={`${shipping} 笔已入库待发货`} note="填写得物单号、售价和发货快递" action="更新发货" onClick={onOrders} /><Task icon="!" tone="blue" title={`${stock.filter(s => s.count <= 2).length} 个 SKU 库存偏低`} note="建议生成补货清单" action="查看" onClick={onStock} /></div>
    <SectionHead title="本月概览" note="截至今日" />
    <div className="finance-card"><div><span>采购总额</span><b>{money(purchase)}</b></div><div><span>销售总额</span><b>{money(sales)}</b></div><div className="profit"><span>毛利润（估）</span><b>{money(Math.max(0, sales - orders.reduce((s,o) => s + o.items.filter(i => i.salePrice).reduce((x,i) => x + i.amount,0),0)))}</b></div></div>
  </section>;
}

function SectionHead({ title, note }: { title:string; note:string }) { return <div className="section-head"><h3>{title}</h3><span>{note}</span></div>; }
function Task({ icon,tone,title,note,action,onClick }: { icon:string;tone:string;title:string;note:string;action:string;onClick:() => void }) { return <button className="task-row" onClick={onClick}><i className={tone}>{icon}</i><span><b>{title}</b><small>{note}</small></span><em>{action} ›</em></button>; }

function StockPage({ stock, onSuggest }: { stock:StockItem[]; onSuggest:() => void }) {
  const [query,setQuery] = useState(""); const [filter,setFilter] = useState("全部");
  const visible = stock.filter(item => { const tone = item.count === 0 ? "缺货" : item.count <= 2 ? "偏低" : "充足"; return (filter === "全部" || filter === tone) && `${item.sku}${item.title}${item.size}`.toLowerCase().includes(query.toLowerCase()); });
  return <section className="enter"><Search value={query} onChange={setQuery} placeholder="搜索货号 / 商品名 / 尺码" /><div className="chip-row">{["全部","充足","偏低","缺货"].map(v => <button key={v} className={filter === v ? "active" : ""} onClick={() => setFilter(v)}>{v}</button>)}</div><div className="stock-overview"><div><span>在库总数</span><b>{stock.reduce((s,i) => s+i.count,0)}</b></div><div><span>SKU 数</span><b>{stock.length}</b></div><div><span>库存预警</span><b className="danger-number">{stock.filter(s => s.count <= 2).length}</b></div></div><SectionHead title="SKU 库存" note={`${visible.length} 条结果`} /><div className="sku-list">{visible.map(item => { const tone = item.count === 0 ? "red" : item.count <= 2 ? "orange" : "green"; const label = item.count === 0 ? "缺货" : item.count <= 2 ? "偏低" : "充足"; return <article key={`${item.sku}${item.size}`}><div className="product-monogram">{item.title.slice(0,2)}</div><div className="sku-main"><div><h4>{item.sku} · {item.title}</h4><Badge tone={tone}>{label}</Badge></div><p>{item.size}码 · 库存 <b>{item.count}</b> 件</p><small>{item.locations.length ? `库位 ${item.locations.join(" / ")}` : `最近售出 ${item.lastSold}`}</small></div>{item.count === 0 && <button onClick={onSuggest}>采购建议</button>}</article>})}</div></section>;
}

function AdminOrders({ orders,onCreate,onEdit,onDelete,onBatchShip,onOpen,onApprove,onReceive,onReject,onShip }: { orders:PurchaseOrder[];onCreate:()=>void;onEdit:(id:string)=>void;onDelete:(ids:string[])=>Promise<boolean>;onBatchShip:(shipments:Array<{orderId:string;courier:string;company:string}>)=>Promise<boolean>;onOpen:(id:string)=>void;onApprove:(id:string)=>void;onReceive:(id:string)=>void;onReject:(id:string)=>void;onShip:(id:string)=>void }) {
  const [query,setQuery] = useState(""); const [status,setStatus] = useState("全部"); const [platform,setPlatform] = useState("全部渠道"); const [buyer,setBuyer] = useState("全部采购员"); const [selectedIds,setSelectedIds]=useState<string[]>([]); const [deleteOpen,setDeleteOpen]=useState(false); const [batchShipOpen,setBatchShipOpen]=useState(false);
  const readyCount=orders.filter(order=>readyToShip(order.status)).length;
  const visible = useMemo(() => orders.filter(order => (status === "全部" || (status === "待发货" ? readyToShip(order.status) : order.status === status)) && (platform === "全部渠道" || order.platform === platform) && (buyer === "全部采购员" || order.purchaser === buyer) && `${order.id}${order.platformNo}${order.courierCompany}${order.courierNo}${order.items.map(item=>`${item.title}${item.sku}${item.outboundCourier??""}`).join("")}`.toLowerCase().includes(query.toLowerCase())), [orders,query,status,platform,buyer]);
  const selectedSet=new Set(selectedIds),selectedReady=orders.filter(order=>selectedSet.has(order.id)&&readyToShip(order.status)),allVisibleSelected=visible.length>0&&visible.every(order=>selectedSet.has(order.id));
  const toggle=(id:string)=>setSelectedIds(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);
  const toggleAll=()=>setSelectedIds(current=>allVisibleSelected?current.filter(id=>!visible.some(order=>order.id===id)):Array.from(new Set([...current,...visible.map(order=>order.id)])));
  async function confirmDelete(){if(await onDelete(selectedIds)){setSelectedIds([]);setDeleteOpen(false);}}
  async function confirmBatchShip(shipments:Array<{orderId:string;courier:string;company:string}>){if(await onBatchShip(shipments)){setSelectedIds(current=>current.filter(id=>!shipments.some(item=>item.orderId===id)));setBatchShipOpen(false);}}
  return <section className="enter">
    <button className="admin-order-create" onClick={onCreate}><span><b>＋ 新增采购订单</b><small>管理员代录订单，保存后进入统一审核流程</small></span><em>去创建 ›</em></button>
    <Search value={query} onChange={setQuery} placeholder="搜索单号 / 快递单号 / 货号" />
    {readyCount>0&&<button className="shipping-guide" onClick={()=>{setStatus("待发货");setPlatform("全部渠道");setBuyer("全部采购员");}}><i>🚚</i><span><b>{readyCount} 笔订单等待更新发货信息</b><small>可单笔更新，或勾选多笔订单批量填写发货物流</small></span><em>查看 ›</em></button>}
    <div className="chip-row scroll">{["全部","待审核","在途","待发货","已发货","已驳回"].map(v => <button key={v} className={status === v ? "active" : ""} onClick={() => setStatus(v)}>{v}</button>)}</div>
    <div className="select-row"><select value={platform} onChange={e => setPlatform(e.target.value)}><option>全部渠道</option>{purchaseChannels.map(channel=><option key={channel}>{channel}</option>)}</select><select value={buyer} onChange={e => setBuyer(e.target.value)}><option>全部采购员</option>{Array.from(new Set(orders.map(order=>order.purchaser))).map(name=><option key={name}>{name}</option>)}</select><select aria-label="日期"><option>近30天</option><option>近7天</option><option>今天</option></select></div>
    <SectionHead title="采购订单" note={`${visible.length} 笔`} />
    <div className="batch-toolbar"><label><input type="checkbox" checked={allVisibleSelected} onChange={toggleAll}/><span>{allVisibleSelected?"取消全选":"全选当前结果"}</span></label><b>{selectedIds.length?`已选择 ${selectedIds.length} 笔`:"可批量选择订单"}</b><button className="batch-ship-button" disabled={!selectedReady.length} onClick={()=>setBatchShipOpen(true)}>批量发货{selectedReady.length?` ${selectedReady.length}`:""}</button><button className="batch-delete-button" disabled={!selectedIds.length} onClick={()=>setDeleteOpen(true)}>批量删除</button></div>
    <div className="order-list">{visible.map(order => <OrderCard key={order.id} order={order} selectable selected={selectedSet.has(order.id)} onSelect={()=>toggle(order.id)} onOpen={() => onOpen(order.id)} showPurchaserContact actions={<><button className="edit-ghost" onClick={() => onEdit(order.id)}>编辑</button>{order.status === "待审核" ? <><button className="danger-ghost" onClick={() => onReject(order.id)}>驳回</button><button className="small-primary" onClick={() => onApprove(order.id)}>✓ 通过</button></> : order.status === "在途" ? <button className="small-primary receive-action" onClick={() => onReceive(order.id)}>手动入库</button> : readyToShip(order.status) ? <button className="small-primary purple-action" onClick={() => onShip(order.id)}>🚚 去发货</button> : order.status === "已发货" ? <button className="small-primary shipping-edit-action" onClick={() => onShip(order.id)}>编辑发货信息</button> : null}</>} />)}</div>
    {deleteOpen&&<DeleteOrdersSheet count={selectedIds.length} onClose={()=>setDeleteOpen(false)} onSubmit={confirmDelete}/>} {batchShipOpen&&<BatchShipSheet orders={selectedReady} onClose={()=>setBatchShipOpen(false)} onSubmit={confirmBatchShip}/>}
  </section>;
}

function OrderCard({ order,onOpen,actions,selectable=false,selected=false,onSelect,showOutbound=true,normalizeStatus=true,showPurchaserContact=false }: { order:PurchaseOrder;onOpen:()=>void;actions?:React.ReactNode;selectable?:boolean;selected?:boolean;onSelect?:()=>void;showOutbound?:boolean;normalizeStatus?:boolean;showPurchaserContact?:boolean }) { return <article className={`order-card edge-${statusTone[order.status]} ${selected?"selected":""}`}>{selectable&&<label className="order-select"><input type="checkbox" aria-label={`选择订单 ${order.id}`} checked={selected} onChange={onSelect}/><span>选择</span></label>}<div className="order-main" role="button" tabIndex={0} onClick={onOpen} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onOpen();}}}><div className="order-top"><h4>{order.itemCount>1?`${order.title} 等${order.itemCount}件商品`:`${order.title} · ${order.items[0]?.size}码`}</h4><Badge tone={statusTone[order.status]}>{normalizeStatus?statusLabel(order.status):order.status}</Badge></div><div className="order-meta"><span>{order.platform} · {order.purchaser}上传</span><b>{money(order.amount)}</b></div><div className="order-meta secondary">{order.platformNo?<CopyNumber value={order.platformNo} label="平台订单号"/>:<span>平台单号未填写</span>}<time>{order.createdAt}</time></div>{showPurchaserContact&&<div className="order-contact"><span>采购员联系方式</span><div>{order.purchaserWechatId&&<div className="contact-value"><em>微信</em><CopyNumber value={order.purchaserWechatId} label="采购员微信号"/></div>}{order.purchaserPhone&&<div className="contact-value"><em>手机</em><CopyNumber value={order.purchaserPhone} label="采购员手机号"/></div>}</div></div>}<div className={`order-courier ${order.courierNo ? "" : "empty"}`}><span>采购快递信息</span><b><span>{[order.courierCompany,order.courierNo].filter(Boolean).join(" · ") || "未填写"}</span>{order.courierNo&&<CopyButton value={order.courierNo} label="采购快递单号"/>}</b></div>{showOutbound&&(readyToShip(order.status)||order.status==="已发货")&&<div className={`order-courier outbound ${order.items.some(item=>item.shipped)?"":"empty"}`}><span>发货进度</span><b><span>{order.items.filter(item=>item.shipped).length}/{order.itemCount} 件已发货</span></b></div>}{order.rejectReason && <p className="reject-note">原因：{order.rejectReason}</p>}</div>{actions && <div className="order-actions">{actions}</div>}</article>; }

function BuyerOrderCard({order,onOpen}:{order:PurchaseOrder;onOpen:()=>void}){
  return <OrderCard order={order} onOpen={onOpen} showOutbound={false} normalizeStatus={false}/>;
}

function BuyerHome({ buyerName,orders,onUpload,onMine,onEdit }: { buyerName:string;orders:PurchaseOrder[];onUpload:()=>void;onMine:()=>void;onEdit:(id:string)=>void }) {
  const rejected=orders.find(o=>o.status==="已驳回"); const count=(status:OrderStatus)=>orders.filter(o=>o.status===status).length;
  return <section className="enter buyer-home">
    <div className="buyer-welcome"><span>采购员 · {buyerName}</span><h2>今天也要买到好价 👋</h2><p>订单及时上报，仓库收货更高效</p></div>
    <div className="buyer-stats"><button onClick={onMine}><b>{count("待审核")}</b><span>待审核</span></button><button onClick={onMine}><b>{count("在途")}</b><span>在途</span></button><button onClick={onMine}><b>{count("已入库")}</b><span>已入库</span></button><button onClick={onMine}><b>{orders.length}</b><span>本月单数</span></button></div>
    {rejected&&<div className="rejected-alert"><div><span>!</span><b>有订单被驳回</b></div><h4>{rejected.title}{rejected.itemCount>1?` 等${rejected.itemCount}件`:""}</h4><p>{rejected.rejectReason}</p><button onClick={()=>onEdit(rejected.id)}>修改后重新提交</button></div>}
    <SectionHead title="快捷操作" note="10 秒完成上报"/><div className="buyer-quick"><button className="upload-quick" onClick={onUpload}><i>＋</i><span><b>上传采购订单</b><small>填写渠道、商品与物流信息</small></span><em>›</em></button><button onClick={onMine}><i>▤</i><span><b>查看我的订单</b><small>跟踪审核、在途与入库状态</small></span><em>›</em></button></div>
    <SectionHead title="最近订单" note="查看全部"/><div className="order-list compact">{orders.slice(0,2).map(order=><BuyerOrderCard key={order.id} order={order} onOpen={onMine}/>)}</div>
  </section>;
}

function UploadPage({mode,editing,onCancel,onSubmit}:{mode:"admin"|"buyer";editing?:PurchaseOrder;onCancel?:()=>void;onSubmit:(order:PurchaseOrder,files:File[])=>Promise<void>}){
  const initialCourierCompany=editing?.courierCompany??"";
  const [platform,setPlatform]=useState(editing?.platform??"京东"),[platformNo,setPlatformNo]=useState(editing?.platformNo??""),[courierCompany,setCourierCompany]=useState(courierCompanyChoice(initialCourierCompany)),[customCourierCompany,setCustomCourierCompany]=useState(courierCompanyChoice(initialCourierCompany)==="其他"?initialCourierCompany:""),[courier,setCourier]=useState(editing?.courierNo??""),[files,setFiles]=useState<File[]>([]),[submitting,setSubmitting]=useState(false);
  const [items,setItems]=useState<Array<{id:string;title:string;sku:string;size:string;qty:number;amount:string}>>(()=>editing?editing.items.map(item=>({id:item.id,title:item.title,sku:item.sku,size:item.size,qty:item.qty,amount:item.amount.toString()})):[{id:"",title:"",sku:"",size:"",qty:1,amount:""}]);
  const resolvedCourierCompany=courierCompany==="其他"?customCourierCompany.trim():courierCompany;
  const updateItem=(index:number,patch:Partial<{title:string;sku:string;size:string;qty:number;amount:string}>)=>setItems(current=>current.map((item,i)=>i===index?{...item,...patch}:item));
  const itemsValid=items.every(item=>item.title.trim()&&item.sku.trim()&&item.size.trim()&&Number(item.amount)>0);
  async function submit(event:FormEvent){event.preventDefault();if(!itemsValid||!courier.trim()||!resolvedCourierCompany)return;setSubmitting(true);try{await onSubmit({id:editing?.id??"",platform,platformNo,courierCompany:resolvedCourierCompany,courierNo:courier.trim(),status:"待审核",purchaser:"",createdAt:"",title:items[0].title.trim(),itemCount:items.length,amount:items.reduce((sum,item)=>sum+Number(item.amount),0),items:items.map(item=>({id:item.id,title:item.title.trim(),sku:item.sku.trim(),size:item.size.trim(),qty:item.qty,amount:Number(item.amount)})),images:editing?.images??[]},files);}finally{setSubmitting(false);}}
  return <section className="enter upload-page"><div className="form-intro"><div><span>{editing?(mode==="admin"?"ADMIN EDIT":"驳回订单修改"):mode==="admin"?"ADMIN PURCHASE":"NEW PURCHASE"}</span><h2>{editing?(mode==="admin"?"编辑采购订单":"修改并重新提交"):mode==="admin"?"新增采购订单":"上报采购订单"}</h2><p>{mode==="admin"?"以管理员身份录入，订单与附件将持久化保存到服务器。":"订单与附件将持久化保存到服务器，提交后可跨设备查看。"}</p></div>{onCancel&&<button className="form-back-button" type="button" onClick={onCancel}>返回订单</button>}</div>{editing?.rejectReason&&<div className="inline-warning"><b>驳回原因</b><span>{editing.rejectReason}</span></div>}<form className="purchase-form" onSubmit={submit}><div className="field-grid"><label><span>采购渠道 *</span><select value={platform} onChange={e=>setPlatform(e.target.value)}>{purchaseChannels.map(channel=><option key={channel}>{channel}</option>)}</select></label><label><span>平台订单号（选填）</span><input value={platformNo} onChange={e=>setPlatformNo(e.target.value)} placeholder="请输入订单号"/></label></div><div className="items-editor">
        <div className="items-editor-head"><b>商品明细</b><span>{items.length} 件商品</span></div>
        {items.map((item,index)=><div className="item-card" key={index}>
          <div className="item-card-head"><i>{index+1}</i><b>{item.title.trim()||`商品 ${index+1}`}</b>{items.length>1&&<button className="item-remove" type="button" aria-label={`删除商品 ${index+1}`} onClick={()=>setItems(current=>current.filter((_,i)=>i!==index))}>删除</button>}</div>
          <label><span>商品名称 *</span><input value={item.title} onChange={e=>updateItem(index,{title:e.target.value})} placeholder="如 乔丹 DUNK LOW 熊猫"/></label>
          <div className="field-grid"><label><span>货号 *</span><input value={item.sku} onChange={e=>updateItem(index,{sku:e.target.value})} placeholder="DD1391-100"/></label><label><span>尺码 *</span><input value={item.size} onChange={e=>updateItem(index,{size:e.target.value})} placeholder="42 / 41.5"/></label></div>
          <div className="field-grid"><label><span>数量 *</span><input type="number" min="1" value={item.qty} onChange={e=>updateItem(index,{qty:Math.max(1,Number(e.target.value))})}/></label><label><span>实付金额 *</span><div className="money-input"><i>¥</i><input inputMode="decimal" value={item.amount} onChange={e=>updateItem(index,{amount:e.target.value})} placeholder="0.00"/></div></label></div>
        </div>)}
        <button type="button" className="item-add-button" onClick={()=>setItems(current=>[...current,{id:"",title:"",sku:"",size:"",qty:1,amount:""}])}><i>＋</i><span><b>添加商品</b><small>同一订单可录入多个商品与尺码</small></span></button>
        <div className="items-total"><span>合计 {items.reduce((sum,item)=>sum+item.qty,0)} 件</span><b>{money(items.reduce((sum,item)=>sum+(Number(item.amount)||0),0))}</b></div>
      </div><div className="field-grid"><label><span>采购快递公司</span><select value={courierCompany} onChange={e=>setCourierCompany(e.target.value)}>{courierCompanies.map(company=><option key={company}>{company}</option>)}<option>其他</option></select></label><label><span>采购快递单号 *</span><input value={courier} onChange={e=>setCourier(e.target.value)} placeholder="粘贴物流单号，方便仓库识别收货"/></label></div>{courierCompany==="其他"&&<label><span>其他快递公司 <em>必填</em></span><input value={customCourierCompany} onChange={e=>setCustomCourierCompany(e.target.value)} placeholder="请输入快递公司名称"/></label>}<label className="upload-zone"><input type="file" accept="image/*" multiple onChange={e=>setFiles(Array.from(e.target.files??[]).slice(0,3))}/><i>＋</i><b>{files.length?`已选择 ${files.length} 张截图`:"上传订单截图"}</b><span>持久化保存，最多 3 张、单张不超过 5MB</span></label><button className="primary-button" disabled={submitting||!itemsValid||!courier.trim()||!resolvedCourierCompany} type="submit">{submitting?"正在保存…":editing?(mode==="admin"?"保存订单修改":"重新提交审核"):mode==="admin"?"创建采购订单":"提交订单"}</button><p className="form-footnote">平台订单号选填；填写后平台与订单号组合唯一，系统会自动阻止重复上报</p></form></section>;
}

function BuyerOrders({ orders,onOpen }: { orders:PurchaseOrder[];onOpen:(id:string)=>void }) { const [status,setStatus] = useState("全部"); const [query,setQuery] = useState(""); const [platform,setPlatform] = useState("全部渠道"); const visible = orders.filter(o => (status === "全部" || o.status === status) && (platform === "全部渠道" || o.platform === platform) && `${o.title}${o.items.map(item=>item.sku).join("")}${o.platformNo}${o.courierCompany}${o.courierNo}`.toLowerCase().includes(query.toLowerCase())); return <section className="enter"><Search value={query} onChange={setQuery} placeholder="搜索商品 / 订单号 / 快递单号" /><div className="chip-row scroll">{["全部","待审核","在途","已入库","已驳回"].map(v => <button key={v} className={status === v ? "active" : ""} onClick={() => setStatus(v)}>{v}</button>)}</div><div className="chip-row scroll">{["全部渠道",...purchaseChannels].map(v => <button key={v} className={platform === v ? "active" : ""} onClick={() => setPlatform(v)}>{v}</button>)}</div><SectionHead title="我的采购订单" note={`${visible.length} 笔`} /><div className="order-list">{visible.map(order => <BuyerOrderCard key={order.id} order={order} onOpen={() => onOpen(order.id)} />)}</div></section>; }

function AdminProfile({user,people,onRole,onActive,onCreate,onReview,onResetPassword,onNotify}:{user:AppUser;people:AppUser[];onRole:(id:string,role:Role)=>void;onActive:(id:string,active:boolean)=>void;onCreate:(member:Record<string,unknown>)=>void;onReview:(id:string,decision:"approve"|"reject")=>void;onResetPassword:(id:string,password:string)=>Promise<boolean>;onNotify:(text:string)=>void}){
  const [showCreate,setShowCreate]=useState(false);
  const [resetTarget,setResetTarget]=useState<AppUser|null>(null);
  const applications=people.filter(person=>person.approvalStatus!=="approved");
  const members=people.filter(person=>person.approvalStatus==="approved");
  const pendingCount=applications.filter(person=>person.approvalStatus==="pending").length;
  function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const data=new FormData(event.currentTarget);onCreate({name:String(data.get("name")??""),phone:String(data.get("phone")??""),wechatId:String(data.get("wechatId")??""),password:String(data.get("password")??""),role:String(data.get("role")??"buyer")});event.currentTarget.reset();setShowCreate(false);}
  return <section className="enter profile-page">
    <div className="profile-card"><div className="avatar">{user.name.slice(0,1)}</div><div><h2>{user.name}</h2><span>微信号：{user.wechatId}</span></div><Badge tone="purple">管理员</Badge></div>
    <SectionHead title="采购员申请" note={pendingCount?`${pendingCount} 个待审批`:"暂无待审批"}/>
    {applications.length?<div className="application-list">{applications.map(person=><article key={person.id} className={person.approvalStatus==="rejected"?"application-rejected":""}><div className="application-avatar">{person.name.slice(0,1)}</div><div className="application-main"><div><b>{person.name}</b><Badge tone={person.approvalStatus==="pending"?"orange":"red"}>{person.approvalStatus==="pending"?"待审批":"未通过"}</Badge></div><span>{person.phone}</span><small>微信号：{person.wechatId}</small></div><div className="application-actions">{person.approvalStatus==="pending"&&<button className="application-reject" onClick={()=>onReview(person.id,"reject")}>拒绝</button>}<button className="application-approve" onClick={()=>onReview(person.id,"approve")}>{person.approvalStatus==="pending"?"通过":"重新通过"}</button></div></article>)}</div>:<div className="application-empty"><i>✓</i><span>当前没有待处理的采购员申请</span></div>}
    <SectionHead title="成员与权限" note={`${members.length} 人`}/>
    <button className="member-create-button" onClick={()=>setShowCreate(value=>!value)}>＋ 创建成员账号</button>
    {showCreate&&<form className="member-create-form" onSubmit={submit}><input name="name" required placeholder="成员姓名"/><input name="phone" type="tel" required inputMode="numeric" pattern="1[3-9][0-9]{9}" maxLength={11} placeholder="11 位手机号"/><input name="wechatId" required minLength={6} maxLength={20} pattern="[A-Za-z][A-Za-z0-9_-]{5,19}" placeholder="微信号"/><input name="password" type="password" required minLength={8} placeholder="初始密码（至少 8 位）"/><select name="role" defaultValue="buyer"><option value="buyer">采购员</option><option value="admin">管理员</option></select><button className="primary-button" type="submit">创建账号</button></form>}
    <div className="member-list">{members.map(person=><div key={person.id} className={!person.active?"member-disabled":""}><span><b>{person.name}</b><small>{person.wechatId}{person.phone?` · ${person.phone}`:""}</small></span><select value={person.role} disabled={person.id===user.id||!person.active} onChange={e=>onRole(person.id,e.target.value as Role)}><option value="buyer">采购员</option><option value="admin">管理员</option></select><button className="member-state-button" onClick={()=>setResetTarget(person)}>改密</button>{person.id!==user.id&&<button className="member-state-button" onClick={()=>onActive(person.id,!person.active)}>{person.active?"停用":"启用"}</button>}</div>)}</div>
    {resetTarget&&<ResetPasswordSheet member={resetTarget} onClose={()=>setResetTarget(null)} onSubmit={onResetPassword}/>}
    <SectionHead title="系统能力" note="独立部署"/><div className="profile-menu"><button onClick={()=>onNotify("利润数据由已发货订单实时计算")}><i>📈</i><span>利润统计</span><small>实时</small><em>›</em></button><a href="/api/export"><i>📤</i><span>导出订单数据</span><small>CSV</small><em>›</em></a><button onClick={()=>onNotify("平台适配器需在服务器环境变量中配置凭证")}><i>🔗</i><span>外部平台连接</span><small>服务端配置</small><em>›</em></button></div>
    <a className="logout" href="/api/auth/logout">退出登录</a><p className="version">骏骏订单 v2.0 · 独立服务器版</p>
  </section>;
}

function ResetPasswordSheet({member,onClose,onSubmit}:{member:AppUser;onClose:()=>void;onSubmit:(id:string,password:string)=>Promise<boolean>}){
  const [password,setPassword]=useState(""),[confirm,setConfirm]=useState(""),[busy,setBusy]=useState(false);
  const mismatch=confirm.length>0&&password!==confirm;
  async function submit(){if(busy||password.length<8||password!==confirm)return;setBusy(true);try{if(await onSubmit(member.id,password))onClose();}finally{setBusy(false);}}
  return <Modal title="重置成员密码" subtitle={member.wechatId} onClose={onClose}>
    <div className="modal-product"><b>{member.name}</b><span>{member.role==="admin"?"管理员":"采购员"}{member.active?"":" · 已停用"}</span></div>
    <label className="modal-field"><span>新密码（至少 8 位）</span><input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="请输入新密码" autoComplete="new-password"/></label>
    <label className="modal-field"><span>确认新密码 {mismatch&&<em className="field-error">两次输入不一致</em>}</span><input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="再次输入新密码" autoComplete="new-password"/></label>
    <button className="primary-button" disabled={password.length<8||password!==confirm||busy} onClick={()=>void submit()}>{busy?"正在重置…":"确认重置密码"}</button>
    <p className="form-footnote">重置后立即生效，请线下告知成员新密码</p>
  </Modal>;
}

function ReceiptSheet({ orders,onClose,onReceive,onManual,onNotify }: { orders:PurchaseOrder[];onClose:()=>void;onReceive:(id:string,loc:string)=>void;onManual:()=>void;onNotify:(t:string)=>void }) {
  const [stage,setStage]=useState<"capture"|"result">("capture"),[courier,setCourier]=useState(""),[location,setLocation]=useState(""),[busy,setBusy]=useState(false); const match=orders.find(order=>order.courierNo===courier&&order.status==="在途");
  async function recognize(file?:File){if(!file)return;setBusy(true);try{const form=new FormData();form.set("image",file);const response=await fetch("/api/receipt/ocr",{method:"POST",body:form});const json=await response.json() as {courierNo:string;error?:string};if(!response.ok)throw new Error(json.error||"识别失败");setCourier(json.courierNo);setStage("result");onNotify("面单识别完成");}catch(error){onNotify(error instanceof Error?error.message:"识别失败");}finally{setBusy(false);}}
  if(stage==="capture")return <Modal title="拍照识别收货" subtitle="OCR RECEIPT" onClose={onClose}><label className="camera-zone"><input type="file" accept="image/*" capture="environment" disabled={busy} onChange={e=>void recognize(e.target.files?.[0])}/><i>📷</i><b>{busy?"正在安全识别…":"对准快递面单拍摄"}</b><span>图片仅发送到已配置的服务端 OCR 接口</span></label><label className="secondary-upload"><input type="file" accept="image/*" disabled={busy} onChange={e=>void recognize(e.target.files?.[0])}/>从相册选择</label><button className="text-button" onClick={onManual}>或手动输入快递单号查询</button></Modal>;
  return <Modal title="识别结果" subtitle="MATCH RESULT" onClose={onClose}><div className="recognized-card"><div><b>📷 面单已识别</b><Badge tone={match?"green":"orange"}>{match?"识别成功":"识别完成"}</Badge></div><label><span>快递单号</span><input value={courier} onChange={e=>setCourier(e.target.value)}/></label></div>{match?<div className="match-card"><h3>✓ 关联到 1 笔采购订单</h3><KeyValue label="货品" value={match.itemCount>1?`${match.title} 等${match.itemCount}件商品`:`${match.title} ${match.items[0]?.size}码`}/><KeyValue label="商品清单" value={match.items.map(item=>`${item.sku}/${item.size}码×${item.qty}`).join("，")}/><KeyValue label="采购订单号" value={match.id} copyValue={match.id}/><KeyValue label="渠道" value={`${match.platform} · ${match.platformNo||"未填写"}`} copyValue={match.platformNo||undefined}/><KeyValue label="采购快递单号" value={[match.courierCompany,match.courierNo].filter(Boolean).join(" · ")||"未填写"} copyValue={match.courierNo}/><KeyValue label="采购员 / 时间" value={`${match.purchaser} · ${match.createdAt}`}/><KeyValue label="采购金额" value={money(match.amount)}/><label className="location-field"><span>库位（必填）</span><input value={location} onChange={e=>setLocation(e.target.value)} placeholder="如 A-02-5"/></label><button className="primary-button" onClick={()=>location&&onReceive(match.id,location)}>核对无误，确认入库</button></div>:<Unmatched orders={orders} courier={courier} onBind={id=>{const order=orders.find(item=>item.id===id);if(order){setCourier(order.courierNo||courier);onNotify("已绑定候选订单");}}} onAbnormal={()=>onNotify("已标记为异常包裹")}/>}</Modal>;
}

function Unmatched({ orders,courier,onBind,onAbnormal }: { orders:PurchaseOrder[];courier:string;onBind:(id:string)=>void;onAbnormal:()=>void }) { const candidates = orders.filter(o => o.status === "在途").slice(0,2); return <><div className="unmatched"><h3>! 未找到关联采购订单</h3><p>可能原因：采购员未填快递单号，或单号识别有误。</p></div><div className="candidate-card"><h3>尾号 {courier.slice(-4)} 的在途订单</h3>{candidates.map(o => <div key={o.id}><span><b>{o.itemCount>1?`${o.title} 等${o.itemCount}件`:`${o.title} ${o.items[0]?.size}码`}</b><small>{o.platform} · {o.purchaser} · {money(o.amount)}</small></span><button onClick={() => onBind(o.id)}>绑定此单</button></div>)}</div><button className="secondary-button" onClick={onAbnormal}>标记为异常包裹</button></>; }

function ScanSheet({ orders,onClose,onReceive,onNotify }: { orders:PurchaseOrder[];onClose:()=>void;onReceive:(id:string,loc:string)=>void;onNotify:(t:string)=>void }) { const [value,setValue] = useState(""); const [location,setLocation] = useState(""); const match = orders.find(o => o.status === "在途" && (o.courierNo.includes(value) || o.id.includes(value) || o.items.some(item=>item.sku.toLowerCase().includes(value.toLowerCase()))) && value.length >= 4); return <Modal title="扫码 / 手输入库" subtitle="QUICK RECEIPT" onClose={onClose}><div className="scanner-box"><div className="scan-beam" /><i>⌗</i><b>对准包裹条码</b><span>扫码枪输入后将自动匹配</span></div><label className="modal-field"><span>订单号 / 快递单号 / 货号后四位</span><input value={value} onChange={e => setValue(e.target.value)} placeholder="请输入至少 4 位" /></label>{match && <div className="match-card compact-match"><h3>匹配到 1 笔在途订单</h3><KeyValue label="采购订单号" value={match.id} copyValue={match.id}/><KeyValue label="商品" value={match.itemCount>1?`${match.title} 等${match.itemCount}件商品`:`${match.title} ${match.items[0]?.size}码`} /><KeyValue label="渠道" value={`${match.platform} · ${match.platformNo||"未填写"}`} copyValue={match.platformNo||undefined}/><KeyValue label="采购快递单号" value={[match.courierCompany,match.courierNo].filter(Boolean).join(" · ")||"未填写"} copyValue={match.courierNo}/><KeyValue label="采购员" value={match.purchaser} /><label className="location-field"><span>库位（必填）</span><input value={location} onChange={e => setLocation(e.target.value)} placeholder="如 A-02-5" /></label><button className="primary-button" onClick={() => location && onReceive(match.id,location)}>确认入库</button></div>}{value.length >= 4 && !match && <div className="inline-warning"><b>未匹配到在途订单</b><span>请检查输入，或使用拍照识别功能。</span></div>}<button className="text-button" onClick={() => onNotify("扫码枪已进入等待状态")}>连接扫码枪</button></Modal>; }

function OrderImages({images}:{images:OrderImage[]}){
  if(!images.length)return null;
  return <section className="order-images"><div className="order-images-head"><h3>订单图片</h3><span>{images.length} 张</span></div><div className="order-images-grid">{images.map(image=><a key={image.id} href={image.url} target="_blank" rel="noreferrer" title={image.fileName}><Image src={image.url} alt={image.fileName} width={180} height={132} unoptimized/><small>{image.uploadedBy}上传</small></a>)}</div></section>;
}

function ManualReceiveSheet({order,onClose,onSubmit}:{order:PurchaseOrder;onClose:()=>void;onSubmit:(id:string,location:string,files:File[])=>Promise<void>}){
  const [location,setLocation]=useState(""),[files,setFiles]=useState<File[]>([]),[busy,setBusy]=useState(false);
  async function confirm(){if(!location.trim()||busy)return;setBusy(true);try{await onSubmit(order.id,location.trim(),files);}finally{setBusy(false);}}
  return <Modal title="手动确认入库" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}><div className="detail-card edge-orange"><div className="detail-title"><h3>{order.itemCount>1?`${order.title} 等${order.itemCount}件商品`:`${order.title} · ${order.items[0]?.size}码`}</h3><Badge tone="orange">在途</Badge></div><KeyValue label="采购渠道 / 单号" value={`${order.platform} · ${order.platformNo||"未填写"}`} copyValue={order.platformNo||undefined}/><KeyValue label="商品清单" value={order.items.map(item=>`${item.sku}/${item.size}码×${item.qty}`).join("，")} /><KeyValue label="采购员" value={order.purchaser} /><KeyValue label="采购快递信息" value={[order.courierCompany,order.courierNo].filter(Boolean).join(" · ")||"未填写"} copyValue={order.courierNo}/></div><OrderImages images={order.images} />{!order.courierNo&&<div className="inline-warning"><b>该订单没有快递单号</b><span>请确认实物与采购订单一致后再手动入库。</span></div>}<label className="location-field"><span>入库库位（必填）</span><input value={location} onChange={e=>setLocation(e.target.value)} placeholder="如 A-02-5" /></label><label className="receipt-upload"><input type="file" accept="image/*" multiple onChange={e=>setFiles(Array.from(e.target.files??[]).slice(0,3))}/><i>＋</i><span><b>{files.length?`已选择 ${files.length} 张入库截图`:"入库截图（选填）"}</b><small>最多 3 张、单张不超过 5MB</small></span></label><button className="primary-button receive-confirm-button" disabled={!location.trim()||busy} onClick={()=>void confirm()}>{busy?"正在入库…":"确认入库并增加库存"}</button><p className="form-footnote manual-receive-note">确认后订单将变为“已入库”，对应 SKU 库存同步增加。</p></Modal>;
}

function OrderDetail({ order,canManage,showLocation,onClose,onApprove,onReceive,onRevertReceive,onReject,onShipItem }: { order:PurchaseOrder;canManage:boolean;showLocation:boolean;onClose:()=>void;onApprove:()=>void;onReceive:()=>void;onRevertReceive:()=>void;onReject:()=>void;onShipItem:(itemId:string)=>void }) { return <Modal title="订单详情" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}><div className={`detail-card edge-${statusTone[order.status]}`}><div className="detail-title"><h3>{order.itemCount>1?`${order.title} 等${order.itemCount}件商品`:`${order.title} · ${order.items[0]?.size}码`}</h3><Badge tone={statusTone[order.status]}>{canManage?statusLabel(order.status):order.status}</Badge></div><KeyValue label="采购渠道" value={order.platform} /><KeyValue label="平台单号" value={order.platformNo||"未填写"} copyValue={order.platformNo||undefined}/><KeyValue label="采购总额" value={money(order.amount)} /><KeyValue label="采购员" value={`${order.purchaser} · ${order.createdAt}`} />{canManage&&order.purchaserWechatId&&<KeyValue label="采购员微信号" value={order.purchaserWechatId} copyValue={order.purchaserWechatId}/>} {canManage&&order.purchaserPhone&&<KeyValue label="采购员手机号" value={order.purchaserPhone} copyValue={order.purchaserPhone}/>}<KeyValue label="采购快递信息" value={[order.courierCompany,order.courierNo].filter(Boolean).join(" · ") || "未填写"} copyValue={order.courierNo}/>{showLocation && order.location && <KeyValue label="库位" value={order.location} />}</div><div className="detail-card items-card">
    <div className="items-card-head"><h3>商品清单</h3><span>{order.itemCount} 件 · {money(order.amount)}</span></div>
    {order.items.map((item,index)=><div className={`item-row ${canManage&&item.shipped?"shipped":""}`} key={item.id}>
      <div className="item-row-lead">
        <i className="item-index">{index+1}</i>
        <div className="item-row-main"><div className="item-row-top"><b>{item.title}</b><em>{money(item.amount)}</em></div><small>{item.sku} · {item.size}码 · ×{item.qty}</small></div>
        {canManage&&readyToShip(order.status)&&!item.shipped&&<button className="item-ship-button" onClick={()=>onShipItem(item.id)}>发货</button>}
        {canManage&&item.shipped&&<button className="item-edit-button" onClick={()=>onShipItem(item.id)}>改物流</button>}
      </div>
      {canManage&&item.shipped&&<div className="item-ship-block">
        <div className="item-ship-line"><span>发货运单</span><b>{item.outboundCourier?<span className="copy-number"><span>{[item.outboundCompany,item.outboundCourier].filter(Boolean).join(" · ")}</span><CopyButton value={item.outboundCourier} label="发货运单号"/></span>:"未填写"}</b></div>
        {(item.resaleNo||item.salePrice)&&<div className="item-ship-line resale"><span>{item.resalePlatform||"二级平台"}</span><b>{item.resaleNo||"未填单号"}{item.salePrice?<em>{money(item.salePrice)}</em>:null}</b></div>}
      </div>}
    </div>)}
  </div><OrderImages images={order.images}/><div className="timeline-card"><h3>流转记录</h3><ol><li><b>{order.createdAt}</b><span>{order.purchaser}上传订单</span></li>{order.status !== "待审核" && order.status !== "已驳回" && <li><b>08-24 15:01</b><span>管理员审核通过</span></li>}{!showLocation&&order.status==="已入库"&&<li><b>已入库</b><span>仓库已完成入库，采购流程结束</span></li>}{showLocation && order.location && <li><b>08-24 16:12</b><span>收货入库 · {order.location}</span></li>}{canManage&&order.items.some(item=>item.resaleNo)&&<li><b>08-24 17:40</b><span>二级平台售出</span></li>}</ol></div>{canManage && order.status === "待审核" && <div className="dual-actions"><button className="secondary-danger" onClick={onReject}>驳回</button><button className="primary-button" onClick={onApprove}>审核通过</button></div>}{canManage && order.status === "在途" && <button className="primary-button receive-confirm-button" onClick={onReceive}>📦 手动确认入库</button>}{canManage && readyToShip(order.status) && !order.items.some(item=>item.shipped) && <button className="revert-receive-button" onClick={onRevertReceive}>↩ 退回在途（撤销入库）</button>}</Modal>; }

function RevertReceiveSheet({order,onClose,onSubmit}:{order:PurchaseOrder;onClose:()=>void;onSubmit:(id:string)=>Promise<boolean>}){
  const [busy,setBusy]=useState(false);
  async function confirm(){if(busy)return;setBusy(true);try{await onSubmit(order.id);}finally{setBusy(false);}}
  return <Modal title="退回在途" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}>
    <div className="modal-product"><b>{order.itemCount>1?`${order.title} 等${order.itemCount}件商品`:`${order.title} · ${order.items[0]?.size}码`}</b><span>{order.platform} · 当前库位 {order.location||"未记录"}</span></div>
    <div className="revert-warning"><i>↩</i><div><b>确定把该订单退回“在途”？</b><p>入库时增加的 {order.items.reduce((sum,item)=>sum+item.qty,0)} 件库存将同步扣回，库位与入库时间会被清空，并留下一条库存调整流水。退回后可重新执行入库。</p></div></div>
    <div className="dual-actions"><button className="secondary-button revert-cancel" disabled={busy} onClick={onClose}>取消</button><button className="primary-button revert-confirm" disabled={busy} onClick={()=>void confirm()}>{busy?"正在退回…":"确认退回在途"}</button></div>
  </Modal>;
}

function RejectSheet({ order,onClose,onSubmit }: { order:PurchaseOrder;onClose:()=>void;onSubmit:(id:string,reason:string)=>void }) { const [reason,setReason] = useState(""); return <Modal title="驳回订单" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}><div className="modal-product"><b>{order.itemCount>1?`${order.title} 等${order.itemCount}件商品`:`${order.title} · ${order.items[0]?.size}码`}</b><span>{order.platform} · {money(order.amount)}</span></div><label className="modal-field"><span>驳回原因（必填）</span><textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="请说明需要采购员修改的内容" /></label><div className="reason-chips">{["平台单号有误","商品信息不完整","采购价格异常"].map(v => <button key={v} onClick={() => setReason(v)}>{v}</button>)}</div><button className="primary-button danger-button" disabled={!reason} onClick={() => onSubmit(order.id,reason)}>确认驳回</button></Modal>; }

function DeleteOrdersSheet({count,onClose,onSubmit}:{count:number;onClose:()=>void;onSubmit:()=>Promise<void>}){
  const [busy,setBusy]=useState(false);
  async function confirm(){setBusy(true);try{await onSubmit();}finally{setBusy(false);}}
  return <Modal title="批量删除订单" subtitle="DANGER ZONE" onClose={onClose}><div className="delete-warning"><i>!</i><div><b>确定删除选中的 {count} 笔订单？</b><p>订单、库存批次和附件记录将同步处理。已入库但未发货的订单会同时扣减对应库存，此操作不可撤销。</p></div></div><div className="dual-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button danger-button" disabled={busy} onClick={()=>void confirm()}>{busy?"正在删除…":"确认批量删除"}</button></div></Modal>;
}

function BatchShipSheet({orders,onClose,onSubmit}:{orders:PurchaseOrder[];onClose:()=>void;onSubmit:(shipments:Array<{orderId:string;courier:string;company:string}>)=>Promise<void>}){
  const [company,setCompany]=useState("顺丰速运"),[customCompany,setCustomCompany]=useState(""),[couriers,setCouriers]=useState<Record<string,string>>(()=>Object.fromEntries(orders.map(order=>[order.id,""]))),[busy,setBusy]=useState(false);
  const resolvedCompany=company==="其他"?customCompany.trim():company;
  const complete=Boolean(resolvedCompany)&&orders.length>0&&orders.every(order=>couriers[order.id]?.trim());
  async function confirm(){if(!complete||busy)return;setBusy(true);try{await onSubmit(orders.map(order=>({orderId:order.id,courier:couriers[order.id].trim(),company:resolvedCompany})));}finally{setBusy(false);}}
  return <Modal title="批量发货" subtitle={`${orders.length} ORDERS`} onClose={onClose}><div className="batch-ship-note"><b>统一物流公司，逐笔填写运单号</b><span>提交后订单内全部待发货商品将一次性发货并扣减库存；任意订单失败时整批不会生效。</span></div><label className="modal-field"><span>发货物流公司 *</span><select value={company} onChange={e=>setCompany(e.target.value)}>{courierCompanies.map(item=><option key={item}>{item}</option>)}<option>其他</option></select></label>{company==="其他"&&<label className="modal-field"><span>其他物流公司 *</span><input value={customCompany} onChange={e=>setCustomCompany(e.target.value)} placeholder="请输入物流公司名称"/></label>}<div className="batch-shipment-list">{orders.map((order,index)=><div key={order.id}><span><b>{index+1}. {order.itemCount>1?`${order.title} 等${order.itemCount}件`:`${order.title} · ${order.items[0]?.size}码`}</b><small><CopyNumber value={order.id} label="采购订单号"/></small></span><input aria-label={`${order.id} 发货运单号`} value={couriers[order.id]??""} onChange={e=>setCouriers(current=>({...current,[order.id]:e.target.value}))} placeholder="请输入该订单发货运单号"/></div>)}</div><button className="primary-button" disabled={!complete||busy} onClick={()=>void confirm()}>{busy?"正在批量发货…":`确认批量发货 ${orders.length} 笔`}</button></Modal>;
}

function ShipSheet({order,item,onClose,onSubmit}:{order:PurchaseOrder;item:OrderItem;onClose:()=>void;onSubmit:(itemId:string,shipped:boolean,resale:string,price:number,courier:string,company:string,resalePlatform:string)=>void}){
  const initialCompany=item.outboundCompany??"";
  const [resalePlatform,setResalePlatform]=useState(item.resalePlatform??"得物"),[resale,setResale]=useState(item.resaleNo??""),[price,setPrice]=useState(item.salePrice?.toString()??""),[company,setCompany]=useState(courierCompanyChoice(initialCompany)),[customCompany,setCustomCompany]=useState(courierCompanyChoice(initialCompany)==="其他"?initialCompany:""),[courier,setCourier]=useState(item.outboundCourier??"");
  const resolvedCompany=company==="其他"?customCompany.trim():company,editingShipping=Boolean(item.shipped);
  return <Modal title={editingShipping?"编辑发货信息":"更新发货信息"} subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}><div className="modal-product"><b>{item.title} · {item.size}码</b><span>{editingShipping?"修改预估售价与物流不会重复扣减库存":`库位 ${order.location} · 当前采购价 ${money(item.amount)}`}</span></div>{!editingShipping&&<div className="field-grid"><label className="modal-field"><span>二级平台</span><select value={resalePlatform} onChange={e=>setResalePlatform(e.target.value)}><option>得物</option><option>闲鱼</option><option>其他</option></select></label><label className="modal-field"><span>二级平台单号（选填）</span><input value={resale} onChange={e=>setResale(e.target.value)} placeholder="可暂不填写平台订单号"/></label></div>}<label className="modal-field"><span>预估售价（选填）</span><input inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)} placeholder="可暂不填写售价"/></label><div className="field-grid"><label className="modal-field"><span>发货物流公司 *</span><select value={company} onChange={e=>setCompany(e.target.value)}>{courierCompanies.map(item=><option key={item}>{item}</option>)}<option>其他</option></select></label><label className="modal-field"><span>发货运单号 *</span><input value={courier} onChange={e=>setCourier(e.target.value)} placeholder="请输入发货运单号"/></label></div>{company==="其他"&&<label className="modal-field"><span>其他物流公司 *</span><input value={customCompany} onChange={e=>setCustomCompany(e.target.value)} placeholder="请输入物流公司名称"/></label>}{price&&<div className="profit-preview"><span>预计单笔毛利</span><b>{money(Math.max(0,Number(price)-item.amount))}</b></div>}<button className="primary-button" disabled={!courier.trim()||!resolvedCompany} onClick={()=>onSubmit(item.id,Boolean(item.shipped),resale,Number(price||0),courier.trim(),resolvedCompany,resalePlatform)}>{editingShipping?"保存预估售价与发货物流":"保存发货信息并扣减库存"}</button></Modal>;
}

function Search({ value,onChange,placeholder }: { value:string;onChange:(v:string)=>void;placeholder:string }) { return <label className="search-box"><i>⌕</i><input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />{value && <button aria-label="清空" onClick={() => onChange("")}>×</button>}</label>; }
function Badge({ tone,children }: { tone:string;children:React.ReactNode }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
function CopyButton({value,label}:{value:string;label:string}){const [state,setState]=useState<"idle"|"copied"|"failed">("idle");async function copy(event:React.MouseEvent<HTMLButtonElement>){event.preventDefault();event.stopPropagation();try{await copyText(value);setState("copied");window.setTimeout(()=>setState("idle"),1600);}catch{setState("failed");window.setTimeout(()=>setState("idle"),1600);}}return <button type="button" className={`copy-button ${state}`} aria-label={`复制${label} ${value}`} title={`复制${label}`} onClick={event=>void copy(event)} onKeyDown={event=>event.stopPropagation()}>{state==="copied"?"✓ 已复制":state==="failed"?"复制失败":"⧉ 复制"}</button>;}
function CopyNumber({value,label}:{value:string;label:string}){return <span className="copy-number"><span>{value}</span><CopyButton value={value} label={label}/></span>;}
function KeyValue({ label,value,highlight=false,copyValue }: { label:string;value:string;highlight?:boolean;copyValue?:string }) { return <div className="key-value"><span>{label}</span><b className={highlight ? "highlight" : ""}>{copyValue?<span className="key-value-copy"><span>{value}</span><CopyButton value={copyValue} label={label}/></span>:value}</b></div>; }
function Modal({ title,subtitle,subtitleCopyValue,onClose,children }: { title:string;subtitle:string;subtitleCopyValue?:string;onClose:()=>void;children:React.ReactNode }) { return <div className="modal-backdrop"><section className="modal-sheet" role="dialog" aria-modal="true" aria-label={title}><div className="sheet-handle"/><header><div>{subtitleCopyValue?<CopyNumber value={subtitleCopyValue} label="采购订单号"/>:<span>{subtitle}</span>}<h2>{title}</h2></div><button aria-label="关闭" onClick={onClose}>×</button></header>{children}</section></div>; }

function AdminNav({ active,onChange,onScan }: { active:AdminTab;onChange:(v:AdminTab)=>void;onScan:()=>void }) { const left:[AdminTab,string,string][] = [["dashboard","▦","看板"],["stock","◫","库存"]]; const right:[AdminTab,string,string][] = [["orders","▤","订单"],["profile","○","我的"]]; return <nav className="bottom-nav">{left.map(([id,icon,label]) => <button key={id} className={active === id ? "active" : ""} onClick={() => onChange(id)}><i>{icon}</i>{label}</button>)}<button className="central-scan" aria-label="扫码入库" onClick={onScan}><i>⌗</i><span>入库</span></button>{right.map(([id,icon,label]) => <button key={id} className={active === id ? "active" : ""} onClick={() => onChange(id)}><i>{icon}</i>{label}</button>)}</nav>; }
function BuyerNav({ active,onChange }: { active:BuyerTab;onChange:(v:BuyerTab)=>void }) { return <nav className="bottom-nav buyer-nav"><button className={active === "home" ? "active" : ""} onClick={() => onChange("home")}><i>⌂</i>首页</button><button className={`buyer-upload ${active === "upload" ? "active" : ""}`} onClick={() => onChange("upload")}><i>＋</i>上传</button><button className={active === "mine" ? "active" : ""} onClick={() => onChange("mine")}><i>▤</i>我的订单</button></nav>; }
