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
  purchaseCourierCompany: string; purchaseCourierNo: string;
  shipped?: boolean; shippedAt?: string; resalePlatform?: string; resaleNo?: string; salePrice?: number; outboundCompany?: string; outboundCourier?: string;
};
type OrderItemDraft = {id:string;title:string;sku:string;size:string;qty:number|"";amount:string;purchaseCourierCompany:string;customPurchaseCourierCompany:string;purchaseCourierNo:string};

type PurchaseOrder = {
  id: string; platform: string; platformNo: string; courierCompany: string; courierNo: string; status: OrderStatus;
  purchaser: string; purchaserPhone?:string; purchaserWechatId?:string; createdAt: string; location?: string; receivedAt?: string; rejectReason?: string;
  title: string; itemCount: number; amount: number; items: OrderItem[];
  images: OrderImage[];
};

type RecognizedOrder = { platform:string; platformNo:string; courierCompany:string; courierNo:string; items:Array<{ title:string; sku:string; size:string; qty:number; amount:number|null }>; notes:string[] };
type StockItem = { sku: string; title: string; size: string; count: number; locations: string[]; lastSold?: string };
type ApprovalStatus = "pending" | "approved" | "rejected";
type AppUser = { id:string; wechatId:string; phone:string; name:string; role:Role; active:boolean; approvalStatus:ApprovalStatus };
type Snapshot = { user:AppUser; orders:PurchaseOrder[]; stock:StockItem[]; users:AppUser[] };

const statusTone: Record<OrderStatus, string> = { "待审核":"gray", "在途":"orange", "已入库":"purple", "待发货":"purple", "已发货":"green", "已驳回":"red" };
const readyToShip = (status:OrderStatus) => status === "已入库" || status === "待发货";
const canRejectOrder = (order:PurchaseOrder) => ["待审核","在途","已入库","待发货"].includes(order.status) && !order.items.some(item=>item.shipped);
const buyerCanEditOrder = (status:OrderStatus) => status === "待审核" || status === "在途" || status === "已驳回";
const statusLabel = (status:OrderStatus) => readyToShip(status) ? "待发货" : status;
const money = (value: number) => `¥${value.toLocaleString("zh-CN", { minimumFractionDigits:2 })}`;
const dateTime = (value?:string) => value ? new Date(value).toLocaleString("zh-CN",{hour12:false}) : "未记录";
/** 订单列表右上角的汇总文案：订单笔数 + 商品件数（各商品行数量之和）。 */
const orderListSummary = (list:PurchaseOrder[]) => `${list.length} 笔 · ${list.reduce((sum,order)=>sum+order.items.reduce((qty,item)=>qty+item.qty,0),0)} 件`;
/** 未选任何状态时显示全部；「待发货」同时匹配已入库与待发货。 */
const matchesStatusFilter = (order:PurchaseOrder, statuses:string[]) => !statuses.length || statuses.some(status => status === "待发货" ? readyToShip(order.status) : order.status === status);
const toggleStatusFilter = (current:string[], value:string) => value === "全部" ? [] : current.includes(value) ? current.filter(item => item !== value) : [...current, value];
const courierCompanies = ["顺丰速运","京东物流","中通快递","圆通速递","申通快递","韵达快递","极兔速递","邮政EMS"] as const;
const purchaseChannels = ["京东","淘宝","抖音","唯品会","拼多多","其他"] as const;
const courierCompanyChoice = (value?:string) => value && courierCompanies.some(company=>company===value) ? value : value ? "其他" : "顺丰速运";
const emptyOrderItemDraft = ():OrderItemDraft => ({id:"",title:"",sku:"",size:"",qty:1,amount:"",purchaseCourierCompany:"顺丰速运",customPurchaseCourierCompany:"",purchaseCourierNo:""});
const resolvedPurchaseCourierCompany = (item:OrderItemDraft) => item.purchaseCourierCompany==="其他"?item.customPurchaseCourierCompany.trim():item.purchaseCourierCompany;

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
  const [uploadNonce, setUploadNonce] = useState(0);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");

  const selected = orders.find(order => order.id === selectedId) ?? orders[0];
  const recentLocations = useMemo(() => Array.from(new Set([...orders].filter(order => order.location).sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? "")).map(order => order.location!.trim()).filter(Boolean))).slice(0, 12), [orders]);
  const notify = (text: string) => { setToast(text); window.setTimeout(() => setToast(""), 2200); };
  const openOrder = (id: string) => { setSelectedId(id); setOverlay("detail"); };
  /** 开始一笔新订单时清掉上次选中的订单，并换 key 让录入表单重新挂载。 */
  const startNewUpload = () => { setSelectedId(""); setUploadNonce(value => value + 1); };
  const applySnapshot = useCallback((data:Snapshot) => { setCurrentUser(data.user);setPeople(data.users);setOrders(data.orders);setStock(data.stock); },[]);
  const load = useCallback(async() => { setLoading(true);setFatalError("");try{const response=await fetch("/api/app",{cache:"no-store"});if(response.status===401){router.replace("/login");return;}const json=await response.json() as Snapshot&{error?:string};if(!response.ok)throw new Error(json.error||"加载失败");applySnapshot(json);}catch(error){setFatalError(error instanceof Error?error.message:"加载失败");}finally{setLoading(false);}},[applySnapshot,router]);
  useEffect(()=>{
    const timer=window.setTimeout(()=>{void load();},0);
    return()=>window.clearTimeout(timer);
  },[load]);
  async function mutate(action:string,payload:Record<string,unknown>={}) { const response=await fetch("/api/app",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,...payload})});if(response.status===401){router.replace("/login");throw new Error("登录已过期");}const json=await response.json() as {data:Snapshot;createdOrderId?:string;deletedCount?:number;shippedCount?:number;deletedUserName?:string;error?:string};if(!response.ok)throw new Error(json.error||"操作失败");applySnapshot(json.data);return json; }
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
  async function deleteUser(userId:string){try{const result=await mutate("delete-user",{userId});notify(`采购员${result.deletedUserName?` ${result.deletedUserName} `:""}已删除`);return true;}catch(error){notify(error instanceof Error?error.message:"删除成员失败");return false;}}
  async function upload(order:PurchaseOrder,files:File[]){try{const editing=orders.find(item=>item.id===order.id);const action=editing?(currentUser?.role==="admin"?"update-order":"resubmit-order"):"create-order";const result=await mutate(action,{...(editing?{orderId:order.id}:{}),platform:order.platform,platformNo:order.platformNo,courierCompany:order.courierCompany,courierNo:order.courierNo,items:order.items.map(item=>({id:item.id,title:item.title,sku:item.sku,size:item.size,qty:item.qty,amount:item.amount,purchaseCourierCompany:item.purchaseCourierCompany,purchaseCourierNo:item.purchaseCourierNo}))});if(files.length&&result.createdOrderId){try{await uploadOrderFiles(result.createdOrderId,files);await load();}catch(error){throw new Error(`订单已保存，但图片上传失败：${error instanceof Error?error.message:"未知错误"}`);}}if(!editing){setSelectedId("");setUploadNonce(value=>value+1);}if(currentUser?.role==="admin")setAdminTab("orders");else setBuyerTab("mine");notify(editing?(currentUser?.role==="admin"?"订单信息已更新":editing.status==="已驳回"?"订单已修改并重新提交审核":"采购订单信息已更新"):currentUser?.role==="admin"?"采购订单已创建，可在订单列表继续审核":"订单提交成功，等待管理员审核");}catch(error){notify(error instanceof Error?error.message:"提交失败");}}

  if(loading)return <main className="app-frame system-state"><div className="system-loader"/><h2>正在连接业务数据</h2><p>正在验证登录状态并载入订单、库存与权限。</p></main>;
  if(fatalError||!currentUser)return <main className="app-frame system-state"><div className="system-error">!</div><h2>系统暂时不可用</h2><p>{fatalError||"无法识别当前用户"}</p><button className="primary-button" onClick={()=>void load()}>重新连接</button></main>;
  const role=currentUser.role;

  return <main className="app-frame">
    <AppHeader user={currentUser} page={role === "admin" ? adminTab : buyerTab} />

    <div className="page-stage">
      {role === "admin" && adminTab === "dashboard" && <AdminDashboard orders={orders} stock={stock} onCreate={() => {startNewUpload();setAdminTab("upload");}} onReceipt={() => setOverlay("receipt")} onOrders={() => setAdminTab("orders")} onStock={() => setAdminTab("stock")} />}
      {role === "admin" && adminTab === "stock" && <StockPage stock={stock} onSuggest={() => notify("已生成 3 条采购建议")} />}
      {role === "admin" && adminTab === "orders" && <AdminOrders orders={orders} onCreate={() => {startNewUpload();setAdminTab("upload");}} onEdit={(id) => {setSelectedId(id);setAdminTab("upload");}} onDelete={deleteOrders} onBatchShip={batchShip} onOpen={openOrder} onApprove={approve} onReceive={(id) => {setSelectedId(id);setOverlay("manual-receive");}} onReject={(id) => { setSelectedId(id); setOverlay("reject"); }} onShip={(id) => { setSelectedId(id); setOverlay("detail"); }} />}
      {role === "admin" && adminTab === "upload" && <UploadPage key={`upload-${selectedId || "new"}-${uploadNonce}`} mode="admin" editing={orders.find(item=>item.id===selectedId)} onCancel={() => setAdminTab("orders")} onSubmit={upload} />}
      {role === "admin" && adminTab === "profile" && <AdminProfile user={currentUser} people={people} onRole={(userId,nextRole)=>void run("set-user-role",{userId,role:nextRole},"用户角色已更新")} onActive={(userId,active)=>void run("set-user-active",{userId,active},active?"账号已启用":"账号已停用")} onCreate={(member)=>void run("create-user",member,"成员账号已创建")} onReview={(userId,decision)=>void run("review-user-application",{userId,decision},decision==="approve"?"采购员申请已通过":"采购员申请已拒绝")} onResetPassword={resetPassword} onDeleteUser={deleteUser} onNotify={notify} />}

      {role === "buyer" && buyerTab === "home" && <BuyerHome buyerName={currentUser.name} orders={orders} onUpload={() => {startNewUpload();setBuyerTab("upload");}} onMine={() => setBuyerTab("mine")} onEdit={(id) => { setSelectedId(id); setBuyerTab("upload"); }} />}
      {role === "buyer" && buyerTab === "upload" && <UploadPage key={`upload-${selectedId || "new"}-${uploadNonce}`} mode="buyer" editing={orders.find(item=>item.id===selectedId&&buyerCanEditOrder(item.status))} onSubmit={upload} />}
      {role === "buyer" && buyerTab === "mine" && <BuyerOrders orders={orders} onOpen={openOrder} onEdit={(id)=>{setSelectedId(id);setBuyerTab("upload");}} />}
    </div>

    {((role === "admin" && adminTab === "orders") || (role === "buyer" && buyerTab === "mine")) && <ScrollToTopButton/>}
    {role === "admin" ? <AdminNav active={adminTab} onChange={setAdminTab} onScan={() => setOverlay("scan")} /> : <BuyerNav active={buyerTab} onChange={(tab) => { if(tab==="upload") startNewUpload(); setBuyerTab(tab); }} />}

    {role === "admin" && overlay === "receipt" && <ReceiptSheet orders={orders} onClose={() => setOverlay(null)} onReceive={receive} onManual={() => setOverlay("scan")} onNotify={notify} />}
    {role === "admin" && overlay === "scan" && <ScanSheet orders={orders} onClose={() => setOverlay(null)} onReceive={receive} onNotify={notify} />}
    {role === "admin" && overlay === "manual-receive" && selected && <ManualReceiveSheet order={selected} recentLocations={recentLocations} onClose={() => setOverlay(null)} onSubmit={receive} />}
    {overlay === "detail" && selected && <OrderDetail order={selected} canManage={role === "admin"} showLocation={role === "admin"} onClose={() => setOverlay(null)} onApprove={() => approve(selected.id)} onReceive={() => setOverlay("manual-receive")} onRevertReceive={() => setOverlay("revert-receive")} onReject={() => setOverlay("reject")} onShipItem={(itemId) => { setSelectedItemId(itemId); setOverlay("ship"); }} />}
    {role === "admin" && overlay === "revert-receive" && selected && <RevertReceiveSheet order={selected} onClose={() => setOverlay(null)} onSubmit={revertReceive} />}
    {role === "admin" && overlay === "reject" && selected && <RejectSheet order={selected} onClose={() => setOverlay(null)} onSubmit={reject} />}
    {role === "admin" && overlay === "ship" && selected && selected.items.length > 0 && <ShipSheet order={selected} item={selected.items.find(item => item.id === selectedItemId) ?? selected.items[0]} onClose={() => setOverlay(null)} onSubmit={ship} />}
    {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
  </main>;
}

function AppHeader({ user, page }: { user:AppUser; page:string }) {
  const labels: Record<string,string> = { dashboard:"管理看板", stock:"库存管理", orders:"订单管理", profile:"我的", home:"鸿运采购", upload:"采购订单录入", mine:"我的订单" };
  return <header className="app-header"><div className="logo">鸿</div><div className="header-copy"><h1>{labels[page]}</h1><span>{user.role === "admin" ? "多渠道采购转卖 · 管理员" : `采购员 · ${user.name}`}</span></div><div className="identity-pill"><b>{user.name.slice(0,1)}</b><span>{user.wechatId}</span><a className="identity-logout" href="/api/auth/logout">退出</a></div></header>;
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
function StatusFilter({ options,value,onChange }: { options:readonly string[];value:string[];onChange:(next:string[])=>void }) {
  return <div className="status-filter">
    <div className="chip-row scroll" role="group" aria-label="按状态筛选，可多选">
      {options.map(option => { const active = option === "全部" ? value.length === 0 : value.includes(option); return <button key={option} type="button" className={active ? "active" : ""} aria-pressed={active} onClick={() => onChange(toggleStatusFilter(value, option))}>{option}</button>; })}
    </div>
    {value.length > 0 && <div className="status-filter-summary" role="status" aria-live="polite">
      <i className="status-filter-mark" aria-hidden="true">✓</i>
      <div className="status-filter-copy"><span>当前筛选</span><b>已选 <em>{value.length}</em> 个状态</b></div>
      <button type="button" className="status-filter-clear" onClick={() => onChange([])}><span>清除筛选</span><i aria-hidden="true">×</i></button>
      <div className="status-filter-values" aria-label="已选择的状态">{value.map(status=><span key={status}>{status}</span>)}</div>
    </div>}
  </div>;
}
function Task({ icon,tone,title,note,action,onClick }: { icon:string;tone:string;title:string;note:string;action:string;onClick:() => void }) { return <button className="task-row" onClick={onClick}><i className={tone}>{icon}</i><span><b>{title}</b><small>{note}</small></span><em>{action} ›</em></button>; }

function StockPage({ stock, onSuggest }: { stock:StockItem[]; onSuggest:() => void }) {
  const [query,setQuery] = useState(""); const [filter,setFilter] = useState("全部");
  const visible = stock.filter(item => { const tone = item.count === 0 ? "缺货" : item.count <= 2 ? "偏低" : "充足"; return (filter === "全部" || filter === tone) && `${item.sku}${item.title}${item.size}`.toLowerCase().includes(query.toLowerCase()); });
  return <section className="enter"><Search value={query} onChange={setQuery} placeholder="搜索货号 / 商品名 / 尺码" historyKey="stock" /><div className="chip-row">{["全部","充足","偏低","缺货"].map(v => <button key={v} className={filter === v ? "active" : ""} onClick={() => setFilter(v)}>{v}</button>)}</div><div className="stock-overview"><div><span>在库总数</span><b>{stock.reduce((s,i) => s+i.count,0)}</b></div><div><span>SKU 数</span><b>{stock.length}</b></div><div><span>库存预警</span><b className="danger-number">{stock.filter(s => s.count <= 2).length}</b></div></div><SectionHead title="SKU 库存" note={`${visible.length} 条结果`} /><div className="sku-list">{visible.map(item => { const tone = item.count === 0 ? "red" : item.count <= 2 ? "orange" : "green"; const label = item.count === 0 ? "缺货" : item.count <= 2 ? "偏低" : "充足"; return <article key={`${item.sku}${item.size}`}><div className="product-monogram">{item.title.slice(0,2)}</div><div className="sku-main"><div><div className="sku-title"><CopyNumber value={item.sku} label="商品货号"/><span>· {item.title}</span></div><Badge tone={tone}>{label}</Badge></div><p>{item.size}码 · 库存 <b>{item.count}</b> 件</p><small>{item.locations.length ? `库位 ${item.locations.join(" / ")}` : `最近售出 ${item.lastSold}`}</small></div>{item.count === 0 && <button onClick={onSuggest}>采购建议</button>}</article>})}</div></section>;
}

function AdminOrders({ orders,onCreate,onEdit,onDelete,onBatchShip,onOpen,onApprove,onReceive,onReject,onShip }: { orders:PurchaseOrder[];onCreate:()=>void;onEdit:(id:string)=>void;onDelete:(ids:string[])=>Promise<boolean>;onBatchShip:(shipments:Array<{orderId:string;courier:string;company:string}>)=>Promise<boolean>;onOpen:(id:string)=>void;onApprove:(id:string)=>void;onReceive:(id:string)=>void;onReject:(id:string)=>void;onShip:(id:string)=>void }) {
  const [query,setQuery] = useState(""); const [statuses,setStatuses] = useState<string[]>([]); const [platform,setPlatform] = useState("全部渠道"); const [buyers,setBuyers] = useState<string[]>([]); const [buyerOpen,setBuyerOpen] = useState(false); const [selectedIds,setSelectedIds]=useState<string[]>([]); const [deleteOpen,setDeleteOpen]=useState(false); const [batchShipOpen,setBatchShipOpen]=useState(false);
  const [dateDays,setDateDays] = useState(30);
  const today = new Date();
  today.setHours(0,0,0,0);
  const rangeStart = new Date(today);
  rangeStart.setDate(rangeStart.getDate() - dateDays + 1);
  const rangeEnd = new Date(today);
  rangeEnd.setDate(rangeEnd.getDate() + 1);
  const dateStart = rangeStart.getTime(), dateEnd = rangeEnd.getTime();
  const readyCount=orders.filter(order=>readyToShip(order.status)).length;
  const purchasers = useMemo(() => Array.from(new Set(orders.map(order => order.purchaser))).sort((a, b) => a.localeCompare(b, "zh-CN")), [orders]);
  const buyerSummary = buyers.length === 0 ? "全部采购员" : buyers.length <= 2 ? buyers.join("、") : `${buyers[0]} 等 ${buyers.length} 人`;
  const toggleBuyer = (name:string) => setBuyers(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name]);
  const visible = useMemo(() => orders.filter(order => new Date(order.createdAt).getTime() >= dateStart && new Date(order.createdAt).getTime() < dateEnd && matchesStatusFilter(order, statuses) && (platform === "全部渠道" || order.platform === platform) && (buyers.length === 0 || buyers.includes(order.purchaser)) && `${order.id}${order.platformNo}${order.items.map(item=>`${item.title}${item.sku}${item.purchaseCourierCompany}${item.purchaseCourierNo}${item.outboundCourier??""}`).join("")}`.toLowerCase().includes(query.toLowerCase())), [orders,query,statuses,platform,buyers,dateStart,dateEnd]);
  const selectedSet=new Set(selectedIds),selectedOrders=orders.filter(order=>selectedSet.has(order.id)),selectedReady=selectedOrders.filter(order=>readyToShip(order.status)),selectedItemQuantity=selectedOrders.reduce((sum,order)=>sum+order.items.reduce((qty,item)=>qty+item.qty,0),0),allVisibleSelected=visible.length>0&&visible.every(order=>selectedSet.has(order.id));
  const toggle=(id:string)=>setSelectedIds(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);
  const toggleAll=()=>setSelectedIds(current=>allVisibleSelected?current.filter(id=>!visible.some(order=>order.id===id)):Array.from(new Set([...current,...visible.map(order=>order.id)])));
  async function confirmDelete(){if(await onDelete(selectedIds)){setSelectedIds([]);setDeleteOpen(false);}}
  async function confirmBatchShip(shipments:Array<{orderId:string;courier:string;company:string}>){if(await onBatchShip(shipments)){setSelectedIds(current=>current.filter(id=>!shipments.some(item=>item.orderId===id)));setBatchShipOpen(false);}}
  return <section className="enter">
    <button className="admin-order-create" onClick={onCreate}><span><b>＋ 新增采购订单</b><small>管理员代录订单，保存后进入统一审核流程</small></span><em>去创建 ›</em></button>
    <Search value={query} onChange={setQuery} placeholder="搜索单号 / 快递单号 / 货号" historyKey="admin-orders" />
    {readyCount>0&&<button className="shipping-guide" onClick={()=>{setStatuses(["待发货"]);setPlatform("全部渠道");setBuyers([]);}}><i>🚚</i><span><b>{readyCount} 笔订单等待更新发货信息</b><small>可单笔更新，或勾选多笔订单批量填写发货物流</small></span><em>查看 ›</em></button>}
    <StatusFilter options={["全部","待审核","在途","待发货","已发货","已驳回"]} value={statuses} onChange={setStatuses} />
    <div className="select-row"><select value={platform} onChange={e => setPlatform(e.target.value)}><option>全部渠道</option>{purchaseChannels.map(channel=><option key={channel}>{channel}</option>)}</select><button type="button" className={`buyer-filter-trigger ${buyers.length ? "active" : ""} ${buyerOpen ? "open" : ""}`} aria-expanded={buyerOpen} aria-haspopup="true" onClick={() => setBuyerOpen(value => !value)}><span>{buyerSummary}</span>{buyers.length > 0 && <b>{buyers.length}</b>}<i>▾</i></button><select aria-label="日期" value={dateDays} onChange={e => setDateDays(Number(e.target.value))}><option value={30}>近30天</option><option value={7}>近7天</option><option value={1}>今天</option><option value={90}>近90天</option></select></div>
    {buyerOpen && <div className="buyer-filter-panel" role="group" aria-label="按采购员筛选">
      <div className="buyer-filter-head"><b>选择采购员</b><span>可多选 · {buyers.length ? `已选 ${buyers.length} 位` : "未选择时显示全部"}</span>{buyers.length > 0 && <button type="button" className="buyer-filter-clear" onClick={() => setBuyers([])}>清空</button>}</div>
      <div className="buyer-filter-options">{purchasers.map(name => { const checked = buyers.includes(name); const count = orders.filter(order => order.purchaser === name).length; return <button key={name} type="button" className={checked ? "checked" : ""} aria-pressed={checked} onClick={() => toggleBuyer(name)}><i>{checked ? "✓" : ""}</i><span>{name}</span><small>{count} 笔</small></button>; })}</div>
      <button type="button" className="buyer-filter-done" onClick={() => setBuyerOpen(false)}>完成</button>
    </div>}
    <SectionHead title="采购订单" note={orderListSummary(visible)} />
    <div className="batch-toolbar"><label><input type="checkbox" checked={allVisibleSelected} onChange={toggleAll}/><span>{allVisibleSelected?"取消全选":"全选当前结果"}</span></label><b>{selectedIds.length?`已选择 ${selectedIds.length} 笔 · 共 ${selectedItemQuantity} 件`:"可批量选择订单"}</b><button className="batch-ship-button" disabled={!selectedReady.length} onClick={()=>setBatchShipOpen(true)}>批量发货{selectedReady.length?` ${selectedReady.length}`:""}</button><button className="batch-delete-button" disabled={!selectedIds.length} onClick={()=>setDeleteOpen(true)}>批量删除</button></div>
    <div className="order-list">{visible.map(order => <OrderCard key={order.id} order={order} selectable selected={selectedSet.has(order.id)} onSelect={()=>toggle(order.id)} onOpen={() => onOpen(order.id)} showPurchaserContact actions={<><button className="edit-ghost" onClick={() => onEdit(order.id)}>编辑</button>{canRejectOrder(order)&&<button className="danger-ghost" onClick={() => onReject(order.id)}>驳回</button>}{order.status === "待审核" ? <><button className="small-primary" onClick={() => onApprove(order.id)}>✓ 通过</button></> : order.status === "在途" ? <button className="small-primary receive-action" onClick={() => onReceive(order.id)}>手动入库</button> : readyToShip(order.status) ? <button className="small-primary purple-action" onClick={() => onShip(order.id)}>🚚 去发货</button> : order.status === "已发货" ? <button className="small-primary shipping-edit-action" onClick={() => onShip(order.id)}>编辑发货信息</button> : null}</>} />)}</div>
    {deleteOpen&&<DeleteOrdersSheet count={selectedIds.length} onClose={()=>setDeleteOpen(false)} onSubmit={confirmDelete}/>} {batchShipOpen&&<BatchShipSheet orders={selectedReady} onClose={()=>setBatchShipOpen(false)} onSubmit={confirmBatchShip}/>}
  </section>;
}

function OrderCard({ order,onOpen,actions,selectable=false,selected=false,onSelect,showOutbound=true,normalizeStatus=true,showPurchaserContact=false }: { order:PurchaseOrder;onOpen:()=>void;actions?:React.ReactNode;selectable?:boolean;selected?:boolean;onSelect?:()=>void;showOutbound?:boolean;normalizeStatus?:boolean;showPurchaserContact?:boolean }) {
  const totalQuantity=order.items.reduce((sum,item)=>sum+item.qty,0);
  const listTitle=order.itemCount>1?`${order.title} 等${order.itemCount}款 · 共${totalQuantity}件`:`${order.title} · ${order.items[0]?.size}码`;
  return <article className={`order-card edge-${statusTone[order.status]} ${selected?"selected":""}`}>
    {selectable&&<label className="order-select"><input type="checkbox" aria-label={`选择订单 ${order.id}`} checked={selected} onChange={onSelect}/><span>选择</span></label>}
    <div className="order-main" role="button" tabIndex={0} onClick={onOpen} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onOpen();}}}>
      <div className="order-top"><h4 title={listTitle}>{listTitle}</h4><Badge tone={statusTone[order.status]}>{normalizeStatus?statusLabel(order.status):order.status}</Badge></div>
      {!showOutbound&&<div className="order-courier"><span>发货状态</span><b>{order.status==="已发货"?"已全部发货":order.items.some(item=>item.shipped)?"部分已发货":"未发货"}</b></div>}<div className="order-meta"><span>{order.platform} · {order.purchaser}上传</span><b>{money(order.amount)}</b></div>
      <div className="order-meta secondary">{order.platformNo?<CopyNumber value={order.platformNo} label="平台订单号"/>:<span>平台单号未填写</span>}<time>{order.createdAt}</time></div>
      {showPurchaserContact&&<div className="order-contact"><span>采购员联系方式</span><div>{order.purchaserWechatId&&<div className="contact-value"><em>微信</em><CopyNumber value={order.purchaserWechatId} label="采购员微信号"/></div>}{order.purchaserPhone&&<div className="contact-value"><em>手机</em><CopyNumber value={order.purchaserPhone} label="采购员手机号"/></div>}</div></div>}
      <div className="order-purchase-logistics"><span>采购快递信息</span><PurchaseCourierList items={order.items} showItem={order.items.length>1}/></div>
      {showOutbound&&(readyToShip(order.status)||order.status==="已发货")&&<OutboundOrderInfo order={order}/>}
      {order.rejectReason && <p className="reject-note">原因：{order.rejectReason}</p>}
    </div>
    {actions && <div className="order-actions">{actions}</div>}
  </article>;
}

function OutboundOrderInfo({order}:{order:PurchaseOrder}){
  const shippedItems=order.items.filter(item=>item.shipped);
  if(order.status!=="已发货")return <div className={`order-courier outbound ${shippedItems.length?"":"empty"}`}><span>发货进度</span><b><span>{shippedItems.reduce((sum,item)=>sum+item.qty,0)}/{order.items.reduce((sum,item)=>sum+item.qty,0)} 件已发货</span></b></div>;
  return <div className="order-shipment-summary"><div className="order-shipment-head"><span>发货信息</span><b>{shippedItems.reduce((sum,item)=>sum+item.qty,0)} 件已发货</b></div>{shippedItems.map(item=><div className="order-shipment-row" key={item.id}><div className="order-shipment-product"><b>{item.title}</b><span>{item.sku} · {item.size}码 · ×{item.qty}</span></div><div className="order-shipment-detail"><span>发货运单</span><b>{item.outboundCompany?<em>{item.outboundCompany}</em>:null}{item.outboundCourier?<CopyNumber value={item.outboundCourier} label="发货运单号"/>:"未填写"}</b></div><div className="order-shipment-detail"><span>发货时间</span><time>{dateTime(item.shippedAt)}</time></div></div>)}</div>;
}

function BuyerOrderCard({order,onOpen,onEdit}:{order:PurchaseOrder;onOpen:()=>void;onEdit?:()=>void}){
  return <OrderCard order={order} onOpen={onOpen} showOutbound={false} normalizeStatus={false} actions={onEdit&&buyerCanEditOrder(order.status)?<button className="edit-ghost buyer-edit-order" onClick={onEdit}>{order.status==="已驳回"?"修改后重新提交":"编辑采购单"}</button>:undefined}/>;
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
  const [platform,setPlatform]=useState(editing?.platform??"京东"),[platformNo,setPlatformNo]=useState(editing?.platformNo??""),[files,setFiles]=useState<File[]>([]),[submitting,setSubmitting]=useState(false);
  const [items,setItems]=useState<OrderItemDraft[]>(()=>editing?editing.items.map(item=>{const company=item.purchaseCourierCompany||editing.courierCompany||"";const choice=courierCompanyChoice(company);return {id:item.id,title:item.title,sku:item.sku,size:item.size,qty:item.qty,amount:item.amount.toString(),purchaseCourierCompany:choice,customPurchaseCourierCompany:choice==="其他"?company:"",purchaseCourierNo:item.purchaseCourierNo||editing.courierNo||""};}):[emptyOrderItemDraft()]);
  const updateItem=(index:number,patch:Partial<OrderItemDraft>)=>setItems(current=>current.map((item,i)=>i===index?{...item,...patch}:item));
  const [recognizing,setRecognizing]=useState(false),[recognition,setRecognition]=useState<{filled:string[];missing:string[];notes:string[];error?:string}|null>(null);
  async function recognize(file?:File){
    if(!file||recognizing)return;
    setRecognizing(true);setRecognition(null);
    try{
      const form=new FormData();form.set("image",file);
      const response=await fetch("/api/orders/recognize",{method:"POST",body:form});
      const json=await response.json() as {data?:RecognizedOrder;error?:string};
      if(!response.ok||!json.data)throw new Error(json.error||"识别失败，请重试");
      const data=json.data,filled:string[]=[],missing:string[]=[];
      if(data.platform&&purchaseChannels.some(channel=>channel===data.platform)){setPlatform(data.platform);filled.push("采购渠道");}else missing.push("采购渠道");
      if(data.platformNo){setPlatformNo(data.platformNo);filled.push("平台订单号");}else missing.push("平台订单号");
      if(data.courierCompany)filled.push("快递公司");else missing.push("快递公司");
      if(data.courierNo)filled.push("快递单号");else missing.push("快递单号");
      if(data.items.length){
        const recognizedCompany=courierCompanyChoice(data.courierCompany);
        const drafts=data.items.map(item=>({id:"",title:item.title,sku:item.sku,size:item.size,qty:item.qty,amount:item.amount!=null&&item.amount>0?String(item.amount):"",purchaseCourierCompany:recognizedCompany,customPurchaseCourierCompany:recognizedCompany==="其他"?data.courierCompany:"",purchaseCourierNo:data.courierNo}));
        setItems(current=>current.every(item=>!item.title.trim()&&!item.sku.trim()&&!item.size.trim()&&!item.amount.trim())?drafts:[...current,...drafts]);
        filled.push(`${data.items.length} 个商品`);
      }else missing.push("商品信息");
      setFiles(current=>current.length>=3||current.some(existing=>existing.name===file.name&&existing.size===file.size)?current:[...current,file]);
      setRecognition({filled,missing,notes:data.notes});
    }catch(error){setRecognition({filled:[],missing:[],notes:[],error:error instanceof Error?error.message:"识别失败，请重试"});}
    finally{setRecognizing(false);}
  }
  const itemsValid=items.every(item=>item.title.trim()&&item.sku.trim()&&item.size.trim()&&Number.isInteger(Number(item.qty))&&Number(item.qty)>0&&Number(item.amount)>0&&resolvedPurchaseCourierCompany(item)&&item.purchaseCourierNo.trim());
  async function submit(event:FormEvent){event.preventDefault();if(!itemsValid)return;const normalizedItems=items.map(item=>({id:item.id,title:item.title.trim(),sku:item.sku.trim(),size:item.size.trim(),qty:Number(item.qty),amount:Number(item.amount),purchaseCourierCompany:resolvedPurchaseCourierCompany(item),purchaseCourierNo:item.purchaseCourierNo.trim()}));setSubmitting(true);try{await onSubmit({id:editing?.id??"",platform,platformNo,courierCompany:normalizedItems[0].purchaseCourierCompany,courierNo:normalizedItems[0].purchaseCourierNo,status:"待审核",purchaser:"",createdAt:"",title:normalizedItems[0].title,itemCount:normalizedItems.length,amount:normalizedItems.reduce((sum,item)=>sum+item.amount,0),items:normalizedItems,images:editing?.images??[]},files);}finally{setSubmitting(false);}}
  return <section className="enter upload-page"><div className="form-intro"><div><span>{editing?(mode==="admin"?"ADMIN EDIT":editing.status==="已驳回"?"驳回订单修改":"PURCHASE EDIT"):mode==="admin"?"ADMIN PURCHASE":"NEW PURCHASE"}</span><h2>{editing?(mode==="admin"?"编辑采购订单":editing.status==="已驳回"?"修改并重新提交":"编辑采购订单"):mode==="admin"?"新增采购订单":"上报采购订单"}</h2><p>{mode==="admin"?"以管理员身份录入，订单与附件将持久化保存到服务器。":editing&&editing.status!=="已驳回"?`订单当前为“${editing.status}”，入库前均可修改并保存。`:"订单与附件将持久化保存到服务器，提交后可跨设备查看。"}</p></div>{onCancel&&<button className="form-back-button" type="button" onClick={onCancel}>返回订单</button>}</div>{editing?.rejectReason&&<div className="inline-warning"><b>驳回原因</b><span>{editing.rejectReason}</span></div>}<form className="purchase-form" autoComplete="off" onSubmit={submit}>
      <label className={`recognize-zone ${recognizing?"busy":""}`}><input type="file" accept="image/*" disabled={recognizing} onChange={e=>{void recognize(e.target.files?.[0]);e.target.value="";}}/><i>{recognizing?"…":"✦"}</i><span><b>{recognizing?"正在识别订单截图，请稍候":"智能识图：上传订单截图自动填写"}</b><small>支持京东 / 拼多多 / 淘宝 / 唯品会 / 抖音的订单详情截图</small><em>此为辅助功能，识图后需核对！</em></span></label>
      {recognition&&(recognition.error?<div className="recognize-result failed"><b>识别失败</b><span>{recognition.error}</span></div>:<div className="recognize-result"><b>已自动填写：{recognition.filled.join("、")||"无"}</b>{recognition.missing.length>0&&<span>未识别到：{recognition.missing.join("、")}，请手动补充</span>}{recognition.notes.map(note=><small key={note}>{note}</small>)}<em>截图已加入订单附件</em></div>)}
      <div className="field-grid"><label><span>采购渠道 *</span><select value={platform} onChange={e=>setPlatform(e.target.value)}>{purchaseChannels.map(channel=><option key={channel}>{channel}</option>)}</select></label><label><span>平台订单号（选填）</span><input value={platformNo} onChange={e=>setPlatformNo(e.target.value)} placeholder="请输入订单号"/></label></div><div className="items-editor">
        <div className="items-editor-head"><b>商品明细</b><span>{items.length} 件商品</span></div>
        {items.map((item,index)=><div className="item-card" key={index}>
          <div className="item-card-head"><i>{index+1}</i><b>{item.title.trim()||`商品 ${index+1}`}</b>{items.length>1&&<button className="item-remove" type="button" aria-label={`删除商品 ${index+1}`} onClick={()=>setItems(current=>current.filter((_,i)=>i!==index))}>删除</button>}</div>
          <label><span>商品名称 *</span><input value={item.title} onChange={e=>updateItem(index,{title:e.target.value})} placeholder="如 乔丹 DUNK LOW 熊猫"/></label>
          <div className="field-grid"><label><span>货号 *</span><input value={item.sku} onChange={e=>updateItem(index,{sku:e.target.value})} placeholder="DD1391-100"/></label><label><span>尺码 *</span><input value={item.size} onChange={e=>updateItem(index,{size:e.target.value})} placeholder="42 / 41.5"/></label></div>
          <div className="field-grid"><label><span>数量 *</span><input type="number" inputMode="numeric" min="1" step="1" value={item.qty} onChange={e=>{const value=e.target.value;updateItem(index,{qty:value===""?"":Math.max(1,Math.trunc(Number(value)))})}} onBlur={()=>{if(item.qty==="")updateItem(index,{qty:1})}}/></label><label><span>实付金额 *</span><div className="money-input"><i>¥</i><input inputMode="decimal" value={item.amount} onChange={e=>updateItem(index,{amount:e.target.value})} placeholder="0.00"/></div></label></div>
          <div className="item-purchase-logistics"><div className="item-purchase-logistics-head"><i>🚚</i><b>该商品采购物流</b><span>每件商品可分别填写</span></div><div className="field-grid"><label><span>采购快递公司 *</span><select value={item.purchaseCourierCompany} onChange={e=>updateItem(index,{purchaseCourierCompany:e.target.value,customPurchaseCourierCompany:e.target.value==="其他"?"":item.customPurchaseCourierCompany})}>{courierCompanies.map(company=><option key={company}>{company}</option>)}<option>其他</option></select></label><label><span>采购快递单号 *</span><input value={item.purchaseCourierNo} onChange={e=>updateItem(index,{purchaseCourierNo:e.target.value})} placeholder="请输入该商品快递单号"/></label></div>{item.purchaseCourierCompany==="其他"&&<label><span>其他快递公司 *</span><input value={item.customPurchaseCourierCompany} onChange={e=>updateItem(index,{customPurchaseCourierCompany:e.target.value})} placeholder="请输入快递公司名称"/></label>}</div>
        </div>)}
        <button type="button" className="item-add-button" onClick={()=>setItems(current=>[...current,emptyOrderItemDraft()])}><i>＋</i><span><b>添加商品</b><small>每个商品可设置不同的采购快递公司与单号</small></span></button>
        <div className="items-total"><span>合计 {items.reduce((sum,item)=>sum+(Number(item.qty)||0),0)} 件</span><b>{money(items.reduce((sum,item)=>sum+(Number(item.amount)||0),0))}</b></div>
      </div><label className="upload-zone"><input type="file" accept="image/*" multiple onChange={e=>setFiles(Array.from(e.target.files??[]).slice(0,3))}/><i>＋</i><b>{files.length?`已选择 ${files.length} 张截图`:"上传订单截图"}</b><span>持久化保存，最多 3 张、单张不超过 5MB</span></label><button className="primary-button" disabled={submitting||!itemsValid} type="submit">{submitting?"正在保存…":editing?(mode==="admin"?"保存订单修改":editing.status==="已驳回"?"重新提交审核":"保存修改"):mode==="admin"?"创建采购订单":"提交订单"}</button><p className="form-footnote">平台订单号选填；每个商品需分别填写采购快递公司与快递单号</p></form></section>;
}

function BuyerOrders({ orders,onOpen,onEdit }: { orders:PurchaseOrder[];onOpen:(id:string)=>void;onEdit:(id:string)=>void }) { const [statuses,setStatuses] = useState<string[]>([]); const [query,setQuery] = useState(""); const [platform,setPlatform] = useState("全部渠道"); const visible = orders.filter(o => matchesStatusFilter(o, statuses) && (platform === "全部渠道" || o.platform === platform) && `${o.title}${o.items.map(item=>`${item.sku}${item.purchaseCourierCompany}${item.purchaseCourierNo}`).join("")}${o.platformNo}`.toLowerCase().includes(query.toLowerCase())); return <section className="enter"><Search value={query} onChange={setQuery} placeholder="搜索商品 / 订单号 / 快递单号" historyKey="buyer-orders" /><StatusFilter options={["全部","待审核","在途","已入库","已发货","已驳回"]} value={statuses} onChange={setStatuses} /><div className="chip-row scroll">{["全部渠道",...purchaseChannels].map(v => <button key={v} className={platform === v ? "active" : ""} onClick={() => setPlatform(v)}>{v}</button>)}</div><SectionHead title="我的采购订单" note={orderListSummary(visible)} /><div className="order-list">{visible.map(order => <BuyerOrderCard key={order.id} order={order} onOpen={() => onOpen(order.id)} onEdit={()=>onEdit(order.id)} />)}</div></section>; }

function AdminProfile({user,people,onRole,onActive,onCreate,onReview,onResetPassword,onDeleteUser,onNotify}:{user:AppUser;people:AppUser[];onRole:(id:string,role:Role)=>void;onActive:(id:string,active:boolean)=>void;onCreate:(member:Record<string,unknown>)=>void;onReview:(id:string,decision:"approve"|"reject")=>void;onResetPassword:(id:string,password:string)=>Promise<boolean>;onDeleteUser:(id:string)=>Promise<boolean>;onNotify:(text:string)=>void}){
  const [showCreate,setShowCreate]=useState(false);
  const [resetTarget,setResetTarget]=useState<AppUser|null>(null);
  const [deleteTarget,setDeleteTarget]=useState<AppUser|null>(null);
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
    <div className="member-list">{members.map(person=><div key={person.id} className={!person.active?"member-disabled":""}><span><b>{person.name}</b><small>{person.wechatId}{person.phone?` · ${person.phone}`:""}</small></span><select value={person.role} disabled={person.id===user.id||!person.active} onChange={e=>onRole(person.id,e.target.value as Role)}><option value="buyer">采购员</option><option value="admin">管理员</option></select><button className="member-state-button" onClick={()=>setResetTarget(person)}>改密</button>{person.id!==user.id&&<button className="member-state-button" onClick={()=>onActive(person.id,!person.active)}>{person.active?"停用":"启用"}</button>}{person.role==="buyer"&&person.id!==user.id&&<button className="member-delete-button" aria-label={`删除采购员 ${person.name}`} onClick={()=>setDeleteTarget(person)}>删除</button>}</div>)}</div>
    {resetTarget&&<ResetPasswordSheet member={resetTarget} onClose={()=>setResetTarget(null)} onSubmit={onResetPassword}/>}
    {deleteTarget&&<DeleteUserSheet member={deleteTarget} onClose={()=>setDeleteTarget(null)} onSubmit={onDeleteUser}/>}
    <SectionHead title="系统能力" note="独立部署"/><div className="profile-menu"><button onClick={()=>onNotify("利润数据由已发货订单实时计算")}><i>📈</i><span>利润统计</span><small>实时</small><em>›</em></button><a href="/api/export"><i>📤</i><span>导出订单数据</span><small>CSV</small><em>›</em></a><button onClick={()=>onNotify("平台适配器需在服务器环境变量中配置凭证")}><i>🔗</i><span>外部平台连接</span><small>服务端配置</small><em>›</em></button></div>
    <a className="logout" href="/api/auth/logout">退出登录</a><p className="version">鸿运采购 v2.0 · 独立服务器版</p>
  </section>;
}

function DeleteUserSheet({member,onClose,onSubmit}:{member:AppUser;onClose:()=>void;onSubmit:(id:string)=>Promise<boolean>}){
  const [busy,setBusy]=useState(false);
  async function confirm(){if(busy)return;setBusy(true);try{if(await onSubmit(member.id))onClose();}finally{setBusy(false);}}
  return <Modal title="删除采购员" subtitle="DANGER ZONE" onClose={onClose}>
    <div className="modal-product"><b>{member.name}</b><span>采购员 · 微信号 {member.wechatId}{member.phone?` · ${member.phone}`:""}{member.active?"":" · 已停用"}</span></div>
    <div className="delete-warning"><i>!</i><div><b>确定删除该采购员账号？</b><p>删除后该账号将无法登录，且不可恢复。只有从未提交过订单、没有任何操作记录的账号才能删除；已有历史记录的账号请改用「停用」。</p></div></div>
    <div className="dual-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button danger-button" disabled={busy} onClick={()=>void confirm()}>{busy?"正在删除…":"确认删除"}</button></div>
  </Modal>;
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
  const [stage,setStage]=useState<"capture"|"result">("capture"),[courier,setCourier]=useState(""),[location,setLocation]=useState(""),[busy,setBusy]=useState(false); const match=orders.find(order=>order.items.some(item=>item.purchaseCourierNo===courier)&&order.status==="在途");
  async function recognize(file?:File){if(!file)return;setBusy(true);try{const form=new FormData();form.set("image",file);const response=await fetch("/api/receipt/ocr",{method:"POST",body:form});const json=await response.json() as {courierNo:string;error?:string};if(!response.ok)throw new Error(json.error||"识别失败");setCourier(json.courierNo);setStage("result");onNotify("面单识别完成");}catch(error){onNotify(error instanceof Error?error.message:"识别失败");}finally{setBusy(false);}}
  if(stage==="capture")return <Modal title="拍照识别收货" subtitle="OCR RECEIPT" onClose={onClose}><label className="camera-zone"><input type="file" accept="image/*" capture="environment" disabled={busy} onChange={e=>void recognize(e.target.files?.[0])}/><i>📷</i><b>{busy?"正在安全识别…":"对准快递面单拍摄"}</b><span>图片仅发送到已配置的服务端 OCR 接口</span></label><label className="secondary-upload"><input type="file" accept="image/*" disabled={busy} onChange={e=>void recognize(e.target.files?.[0])}/>从相册选择</label><button className="text-button" onClick={onManual}>或手动输入快递单号查询</button></Modal>;
  return <Modal title="识别结果" subtitle="MATCH RESULT" onClose={onClose}><div className="recognized-card"><div><b>📷 面单已识别</b><Badge tone={match?"green":"orange"}>{match?"识别成功":"识别完成"}</Badge></div><label><span>快递单号</span><input value={courier} onChange={e=>setCourier(e.target.value)}/></label></div>{match?<div className="match-card"><h3>✓ 关联到 1 笔采购订单</h3><KeyValue label="货品" value={match.itemCount>1?`${match.title} 等${match.itemCount}件商品`:`${match.title} ${match.items[0]?.size}码`}/><KeyValue label="商品清单" value={<SkuList items={match.items}/>}/><KeyValue label="采购订单号" value={match.id} copyValue={match.id}/><KeyValue label="渠道" value={`${match.platform} · ${match.platformNo||"未填写"}`} copyValue={match.platformNo||undefined}/><KeyValue label="采购物流" value={<PurchaseCourierList items={match.items} showItem/>}/><KeyValue label="采购员 / 时间" value={`${match.purchaser} · ${match.createdAt}`}/><KeyValue label="采购金额" value={money(match.amount)}/><label className="location-field"><span>库位（必填）</span><input value={location} onChange={e=>setLocation(e.target.value)} placeholder="如 A-02-5"/></label><button className="primary-button" onClick={()=>location&&onReceive(match.id,location)}>核对无误，确认入库</button></div>:<Unmatched orders={orders} courier={courier} onBind={id=>{const order=orders.find(item=>item.id===id);if(order){setCourier(order.items[0]?.purchaseCourierNo||courier);onNotify("已绑定候选订单");}}} onAbnormal={()=>onNotify("已标记为异常包裹")}/>}</Modal>;
}

function Unmatched({ orders,courier,onBind,onAbnormal }: { orders:PurchaseOrder[];courier:string;onBind:(id:string)=>void;onAbnormal:()=>void }) { const candidates = orders.filter(o => o.status === "在途").slice(0,2); return <><div className="unmatched"><h3>! 未找到关联采购订单</h3><p>可能原因：采购员未填快递单号，或单号识别有误。</p></div><div className="candidate-card"><h3>尾号 {courier.slice(-4)} 的在途订单</h3>{candidates.map(o => <div key={o.id}><span><b>{o.itemCount>1?`${o.title} 等${o.itemCount}件`:`${o.title} ${o.items[0]?.size}码`}</b><small>{o.platform} · {o.purchaser} · {money(o.amount)}</small></span><button onClick={() => onBind(o.id)}>绑定此单</button></div>)}</div><button className="secondary-button" onClick={onAbnormal}>标记为异常包裹</button></>; }

function ScanSheet({ orders,onClose,onReceive,onNotify }: { orders:PurchaseOrder[];onClose:()=>void;onReceive:(id:string,loc:string)=>void;onNotify:(t:string)=>void }) { const [value,setValue] = useState(""); const [location,setLocation] = useState(""); const match = orders.find(o => o.status === "在途" && (o.items.some(item=>item.purchaseCourierNo.includes(value)) || o.id.includes(value) || o.items.some(item=>item.sku.toLowerCase().includes(value.toLowerCase()))) && value.length >= 4); return <Modal title="扫码 / 手输入库" subtitle="QUICK RECEIPT" onClose={onClose}><div className="scanner-box"><div className="scan-beam" /><i>⌗</i><b>对准包裹条码</b><span>扫码枪输入后将自动匹配</span></div><label className="modal-field"><span>订单号 / 快递单号 / 货号后四位</span><input value={value} onChange={e => setValue(e.target.value)} placeholder="请输入至少 4 位" /></label>{match && <div className="match-card compact-match"><h3>匹配到 1 笔在途订单</h3><KeyValue label="采购订单号" value={match.id} copyValue={match.id}/><KeyValue label="商品" value={match.itemCount>1?`${match.title} 等${match.itemCount}件商品`:`${match.title} ${match.items[0]?.size}码`} /><KeyValue label="商品货号" value={<SkuList items={match.items}/>}/><KeyValue label="渠道" value={`${match.platform} · ${match.platformNo||"未填写"}`} copyValue={match.platformNo||undefined}/><KeyValue label="采购物流" value={<PurchaseCourierList items={match.items} showItem/>}/><KeyValue label="采购员" value={match.purchaser} /><label className="location-field"><span>库位（必填）</span><input value={location} onChange={e => setLocation(e.target.value)} placeholder="如 A-02-5" /></label><button className="primary-button" onClick={() => location && onReceive(match.id,location)}>确认入库</button></div>}{value.length >= 4 && !match && <div className="inline-warning"><b>未匹配到在途订单</b><span>请检查输入，或使用拍照识别功能。</span></div>}<button className="text-button" onClick={() => onNotify("扫码枪已进入等待状态")}>连接扫码枪</button></Modal>; }

function OrderImages({images}:{images:OrderImage[]}){
  if(!images.length)return null;
  return <section className="order-images"><div className="order-images-head"><h3>订单图片</h3><span>{images.length} 张</span></div><div className="order-images-grid">{images.map(image=><a key={image.id} href={image.url} target="_blank" rel="noreferrer" title={image.fileName}><Image src={image.url} alt={image.fileName} width={180} height={132} unoptimized/><small>{image.uploadedBy}上传</small></a>)}</div></section>;
}

function ManualReceiveSheet({order,recentLocations,onClose,onSubmit}:{order:PurchaseOrder;recentLocations:string[];onClose:()=>void;onSubmit:(id:string,location:string,files:File[])=>Promise<void>}){
  const [location,setLocation]=useState(""),[files,setFiles]=useState<File[]>([]),[busy,setBusy]=useState(false);
  const activeLocation=location.trim();
  async function confirm(){if(!location.trim()||busy)return;setBusy(true);try{await onSubmit(order.id,location.trim(),files);}finally{setBusy(false);}}
  return <Modal title="手动确认入库" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}><div className="detail-card edge-orange"><div className="detail-title"><h3>{order.itemCount>1?`${order.title} 等${order.itemCount}件商品`:`${order.title} · ${order.items[0]?.size}码`}</h3><Badge tone="orange">在途</Badge></div><KeyValue label="采购渠道 / 单号" value={`${order.platform} · ${order.platformNo||"未填写"}`} copyValue={order.platformNo||undefined}/><KeyValue label="商品清单" value={<SkuList items={order.items}/>} /><KeyValue label="采购员" value={order.purchaser} /><KeyValue label="采购物流" value={<PurchaseCourierList items={order.items} showItem/>}/></div><OrderImages images={order.images} /><label className="location-field"><span>入库库位（必填）</span><input value={location} onChange={e=>setLocation(e.target.value)} placeholder="如 A-02-5，或从下方历史库位中选择" /></label>{recentLocations.length>0&&<div className="location-history"><div className="location-history-head"><i>📍</i><b>历史库位</b><span>{activeLocation&&recentLocations.includes(activeLocation)?`已选 ${activeLocation}`:"点选即可填入，按最近入库排序"}</span></div><div className="location-chips">{recentLocations.map((item,index)=><button key={item} type="button" className={item===activeLocation?"active":""} aria-pressed={item===activeLocation} onClick={()=>setLocation(item)}>{index===0&&<em>最近</em>}<span>{item}</span></button>)}</div></div>}<label className="receipt-upload"><input type="file" accept="image/*" multiple onChange={e=>setFiles(Array.from(e.target.files??[]).slice(0,3))}/><i>＋</i><span><b>{files.length?`已选择 ${files.length} 张入库截图`:"入库截图（选填）"}</b><small>最多 3 张、单张不超过 5MB</small></span></label><button className="primary-button receive-confirm-button" disabled={!location.trim()||busy} onClick={()=>void confirm()}>{busy?"正在入库…":"确认入库并增加库存"}</button><p className="form-footnote manual-receive-note">确认后订单将变为“已入库”，对应 SKU 库存同步增加。</p></Modal>;
}

function OrderDetail({ order,canManage,showLocation,onClose,onApprove,onReceive,onRevertReceive,onReject,onShipItem }: { order:PurchaseOrder;canManage:boolean;showLocation:boolean;onClose:()=>void;onApprove:()=>void;onReceive:()=>void;onRevertReceive:()=>void;onReject:()=>void;onShipItem:(itemId:string)=>void }) { return <Modal title="订单详情" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}><div className={`detail-card edge-${statusTone[order.status]}`}><div className="detail-title"><h3>{order.itemCount>1?`${order.title} 等${order.itemCount}件商品`:`${order.title} · ${order.items[0]?.size}码`}</h3><Badge tone={statusTone[order.status]}>{canManage?statusLabel(order.status):order.status}</Badge></div><KeyValue label="采购渠道" value={order.platform} /><KeyValue label="平台单号" value={order.platformNo||"未填写"} copyValue={order.platformNo||undefined}/><KeyValue label="采购总额" value={money(order.amount)} /><KeyValue label="采购员" value={`${order.purchaser} · ${order.createdAt}`} />{canManage&&order.purchaserWechatId&&<KeyValue label="采购员微信号" value={order.purchaserWechatId} copyValue={order.purchaserWechatId}/>} {canManage&&order.purchaserPhone&&<KeyValue label="采购员手机号" value={order.purchaserPhone} copyValue={order.purchaserPhone}/>}<KeyValue label="采购物流" value={<PurchaseCourierList items={order.items} showItem={order.items.length>1}/>} />{showLocation && order.location && <KeyValue label="库位" value={order.location} />}</div><div className="detail-card items-card">
    <div className="items-card-head"><h3>商品清单</h3><span>{order.itemCount} 件 · {money(order.amount)}</span></div>
    {order.items.map((item,index)=><div className={`item-row ${canManage&&item.shipped?"shipped":""}`} key={item.id}>
      <div className="item-row-lead">
        <i className="item-index">{index+1}</i>
        <div className="item-row-main"><div className="item-row-top"><b>{item.title}</b><em>{money(item.amount)}</em></div><div className="item-sku-meta"><CopyNumber value={item.sku} label="商品货号"/><span>· {item.size}码 · ×{item.qty}</span></div></div>
        {canManage&&readyToShip(order.status)&&!item.shipped&&<button className="item-ship-button" onClick={()=>onShipItem(item.id)}>发货</button>}
        {canManage&&item.shipped&&<button className="item-edit-button" onClick={()=>onShipItem(item.id)}>改物流</button>}
      </div>
      {canManage&&item.shipped&&<div className="item-ship-block">
        <div className="item-ship-line"><span>发货运单</span><b>{item.outboundCourier?<span className="copy-number"><span>{[item.outboundCompany,item.outboundCourier].filter(Boolean).join(" · ")}</span><CopyButton value={item.outboundCourier} label="发货运单号"/></span>:"未填写"}</b></div>
        {(item.resaleNo||item.salePrice)&&<div className="item-ship-line resale"><span>{item.resalePlatform||"二级平台"}</span><b>{item.resaleNo||"未填单号"}{item.salePrice?<em>{money(item.salePrice)}</em>:null}</b></div>}
      </div>}
    </div>)}
  </div><OrderImages images={order.images}/><div className="timeline-card"><h3>流转记录</h3><ol><li><b>{order.createdAt}</b><span>{order.purchaser}上传订单</span></li>{order.status !== "待审核" && order.status !== "已驳回" && <li><b>08-24 15:01</b><span>管理员审核通过</span></li>}{!showLocation&&order.status==="已入库"&&<li><b>已入库</b><span>仓库已完成入库</span></li>}{showLocation && order.location && <li><b>08-24 16:12</b><span>收货入库 · {order.location}</span></li>}{canManage&&order.items.some(item=>item.resaleNo)&&<li><b>08-24 17:40</b><span>二级平台售出</span></li>}</ol></div>{!canManage&&<div className="detail-card"><KeyValue label="发货状态" value={order.status==="已发货"?"已全部发货":order.items.some(item=>item.shipped)?"部分已发货":"未发货"}/></div>}{canManage&&canRejectOrder(order)&&order.status!=="待审核"&&<button className="primary-button danger-button" onClick={onReject}>驳回采购单</button>}{canManage && order.status === "待审核" && <div className="dual-actions"><button className="secondary-danger" onClick={onReject}>驳回</button><button className="primary-button" onClick={onApprove}>审核通过</button></div>}{canManage && order.status === "在途" && <button className="primary-button receive-confirm-button" onClick={onReceive}>📦 手动确认入库</button>}{canManage && readyToShip(order.status) && !order.items.some(item=>item.shipped) && <button className="revert-receive-button" onClick={onRevertReceive}>↩ 退回在途（撤销入库）</button>}</Modal>; }

function RevertReceiveSheet({order,onClose,onSubmit}:{order:PurchaseOrder;onClose:()=>void;onSubmit:(id:string)=>Promise<boolean>}){
  const [busy,setBusy]=useState(false);
  async function confirm(){if(busy)return;setBusy(true);try{await onSubmit(order.id);}finally{setBusy(false);}}
  return <Modal title="退回在途" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}>
    <div className="modal-product"><b>{order.itemCount>1?`${order.title} 等${order.itemCount}件商品`:`${order.title} · ${order.items[0]?.size}码`}</b><span>{order.platform} · 当前库位 {order.location||"未记录"}</span></div>
    <div className="revert-warning"><i>↩</i><div><b>确定把该订单退回“在途”？</b><p>入库时增加的 {order.items.reduce((sum,item)=>sum+item.qty,0)} 件库存将同步扣回，库位与入库时间会被清空，并留下一条库存调整流水。退回后可重新执行入库。</p></div></div>
    <div className="dual-actions"><button className="secondary-button revert-cancel" disabled={busy} onClick={onClose}>取消</button><button className="primary-button revert-confirm" disabled={busy} onClick={()=>void confirm()}>{busy?"正在退回…":"确认退回在途"}</button></div>
  </Modal>;
}

function RejectSheet({ order,onClose,onSubmit }: { order:PurchaseOrder;onClose:()=>void;onSubmit:(id:string,reason:string)=>void }) { const [reason,setReason] = useState(""); return <Modal title="驳回订单" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}><div className="modal-product"><b>{order.itemCount>1?`${order.title} 等${order.itemCount}件商品`:`${order.title} · ${order.items[0]?.size}码`}</b><span>{order.platform} · {money(order.amount)}</span></div>{readyToShip(order.status)&&<p className="inline-warning">驳回后将撤销该采购单入库并回退库存，采购员修改后需重新审核和入库。</p>}<label className="modal-field"><span>驳回原因（必填）</span><textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="请说明需要采购员修改的内容" /></label><div className="reason-chips">{["平台单号有误","商品信息不完整","采购价格异常"].map(v => <button key={v} onClick={() => setReason(v)}>{v}</button>)}</div><button className="primary-button danger-button" disabled={!reason} onClick={() => onSubmit(order.id,reason)}>确认驳回</button></Modal>; }

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

/** 搜索记录保存在浏览器本地（每台设备、每个列表独立），最多 10 条，最近使用排在最前。 */
const searchHistoryLimit=10;
function readSearchHistory(key:string):string[]{try{const raw=window.localStorage.getItem(`junjun.search.${key}`);const list:unknown=raw?JSON.parse(raw):[];return Array.isArray(list)?list.filter((item):item is string=>typeof item==="string"&&item.trim().length>0).slice(0,searchHistoryLimit):[];}catch{return [];}}
function writeSearchHistory(key:string,list:string[]){try{window.localStorage.setItem(`junjun.search.${key}`,JSON.stringify(list.slice(0,searchHistoryLimit)));}catch{/* 隐私模式或存储满时静默忽略 */}}

function Search({ value,onChange,placeholder,historyKey }: { value:string;onChange:(v:string)=>void;placeholder:string;historyKey?:string }) {
  const [history,setHistory]=useState<string[]>([]),[focused,setFocused]=useState(false);
  const focus=()=>{if(historyKey)setHistory(readSearchHistory(historyKey));setFocused(true);};
  const remember=(term:string)=>{const trimmed=term.trim();if(!historyKey||!trimmed)return;setHistory(current=>{const next=[trimmed,...current.filter(item=>item!==trimmed)].slice(0,searchHistoryLimit);writeSearchHistory(historyKey,next);return next;});};
  const forget=(term:string)=>{if(!historyKey)return;setHistory(current=>{const next=current.filter(item=>item!==term);writeSearchHistory(historyKey,next);return next;});};
  const forgetAll=()=>{if(!historyKey)return;setHistory([]);writeSearchHistory(historyKey,[]);};
  const keyword=value.trim().toLowerCase();
  const suggestions=history.filter(item=>item.toLowerCase()!==keyword&&(!keyword||item.toLowerCase().includes(keyword))).slice(0,searchHistoryLimit);
  const open=Boolean(historyKey)&&focused&&suggestions.length>0;
  const keepFocus=(event:React.MouseEvent)=>event.preventDefault();
  return <div className="search-wrap">
    <label className="search-box"><i>⌕</i><input value={value} onChange={e => onChange(e.target.value)} onFocus={focus} onBlur={()=>{remember(value);window.setTimeout(()=>setFocused(false),120);}} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();remember(value);e.currentTarget.blur();}else if(e.key==="Escape")setFocused(false);}} placeholder={placeholder} autoComplete="off" />{value && <button type="button" aria-label="清空" onMouseDown={keepFocus} onClick={() => onChange("")}>×</button>}</label>
    {open&&<div className="search-history" aria-label="搜索记录">
      <div className="search-history-head"><span>搜索记录</span><button type="button" onMouseDown={keepFocus} onClick={forgetAll}>清空记录</button></div>
      {suggestions.map(term=><div key={term} className="search-history-item"><button type="button" className="search-history-pick" onMouseDown={keepFocus} onClick={()=>{onChange(term);remember(term);setFocused(false);}}><i>⟲</i><span>{term}</span></button><button type="button" className="search-history-remove" aria-label={`删除记录 ${term}`} onMouseDown={keepFocus} onClick={()=>forget(term)}>×</button></div>)}
    </div>}
  </div>;
}
function ScrollToTopButton(){return <button type="button" className="scroll-top-button" aria-label="回到订单列表顶部" title="回到顶部" onClick={()=>window.scrollTo({top:0,behavior:"smooth"})}><i>↑</i><span>顶部</span></button>;}
function Badge({ tone,children }: { tone:string;children:React.ReactNode }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
function CopyButton({value,label}:{value:string;label:string}){const [state,setState]=useState<"idle"|"copied"|"failed">("idle");async function copy(event:React.MouseEvent<HTMLButtonElement>){event.preventDefault();event.stopPropagation();try{await copyText(value);setState("copied");window.setTimeout(()=>setState("idle"),1600);}catch{setState("failed");window.setTimeout(()=>setState("idle"),1600);}}return <button type="button" className={`copy-button ${state}`} aria-label={`复制${label} ${value}`} title={`复制${label}`} onClick={event=>void copy(event)} onKeyDown={event=>event.stopPropagation()}>{state==="copied"?"✓ 已复制":state==="failed"?"复制失败":"⧉ 复制"}</button>;}
function CopyNumber({value,label}:{value:string;label:string}){return <span className="copy-number"><span>{value}</span><CopyButton value={value} label={label}/></span>;}
function SkuList({items}:{items:OrderItem[]}){return <span className="sku-copy-list">{items.map(item=><span key={item.id}><CopyNumber value={item.sku} label="商品货号"/><small>{item.size}码 · ×{item.qty}</small></span>)}</span>;}
function PurchaseCourierList({items,showItem=false}:{items:OrderItem[];showItem?:boolean}){return <span className="purchase-courier-list">{items.map(item=><span key={item.id}>{showItem&&<small>{item.sku}</small>}<span>{item.purchaseCourierCompany}</span><CopyNumber value={item.purchaseCourierNo} label="采购快递单号"/></span>)}</span>;}
function KeyValue({ label,value,highlight=false,copyValue }: { label:string;value:React.ReactNode;highlight?:boolean;copyValue?:string }) { return <div className="key-value"><span>{label}</span><b className={highlight ? "highlight" : ""}>{copyValue?<span className="key-value-copy"><span>{value}</span><CopyButton value={copyValue} label={label}/></span>:value}</b></div>; }
function Modal({ title,subtitle,subtitleCopyValue,onClose,children }: { title:string;subtitle:string;subtitleCopyValue?:string;onClose:()=>void;children:React.ReactNode }) { return <div className="modal-backdrop"><section className="modal-sheet" role="dialog" aria-modal="true" aria-label={title}><div className="sheet-handle"/><header><div>{subtitleCopyValue?<CopyNumber value={subtitleCopyValue} label="采购订单号"/>:<span>{subtitle}</span>}<h2>{title}</h2></div><button aria-label="关闭" onClick={onClose}>×</button></header>{children}</section></div>; }

function AdminNav({ active,onChange,onScan }: { active:AdminTab;onChange:(v:AdminTab)=>void;onScan:()=>void }) { const left:[AdminTab,string,string][] = [["dashboard","▦","看板"],["stock","◫","库存"]]; const right:[AdminTab,string,string][] = [["orders","▤","订单"],["profile","○","我的"]]; return <nav className="bottom-nav">{left.map(([id,icon,label]) => <button key={id} className={active === id ? "active" : ""} onClick={() => onChange(id)}><i>{icon}</i>{label}</button>)}<button className="central-scan" aria-label="扫码入库" onClick={onScan}><i>⌗</i><span>入库</span></button>{right.map(([id,icon,label]) => <button key={id} className={active === id ? "active" : ""} onClick={() => onChange(id)}><i>{icon}</i>{label}</button>)}</nav>; }
function BuyerNav({ active,onChange }: { active:BuyerTab;onChange:(v:BuyerTab)=>void }) { return <nav className="bottom-nav buyer-nav"><button className={active === "home" ? "active" : ""} onClick={() => onChange("home")}><i>⌂</i>首页</button><button className={`buyer-upload ${active === "upload" ? "active" : ""}`} onClick={() => onChange("upload")}><i>＋</i>上传</button><button className={active === "mine" ? "active" : ""} onClick={() => onChange("mine")}><i>▤</i>我的订单</button></nav>; }
