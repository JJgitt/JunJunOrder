"use client";

import { FormEvent, useMemo, useState } from "react";

type Tab = "home" | "stock" | "orders" | "profile";
type ScanMode = "in" | "out";

const initialStock = [
  { sku: "DD1872-100", barcode: "194501088343", name: "Nike Dunk Low 熊猫", size: "42", count: 8, location: "A-01-08" },
  { sku: "FV5029-100", barcode: "196154201892", name: "Air Jordan 4 军蓝", size: "41", count: 2, location: "A-03-12" },
  { sku: "IH3114", barcode: "406789756413", name: "adidas Samba OG", size: "38", count: 0, location: "B-02-06" },
  { sku: "HF3165-401", barcode: "197594374423", name: "Nike Air Force 1 蓝白", size: "43", count: 12, location: "A-02-03" },
  { sku: "M1906RER", barcode: "197966503012", name: "New Balance 1906R", size: "40.5", count: 5, location: "C-01-09" },
];

const orders = [
  { id: "DW2026081900186", time: "2026-08-19 10:42", sku: "DD1872-100", name: "Nike Dunk Low 熊猫", size: "42", price: "¥729", state: "待发货" },
  { id: "DW2026081900171", time: "2026-08-19 09:18", sku: "FV5029-100", name: "Air Jordan 4 军蓝", size: "41", price: "¥1,299", state: "已入库" },
  { id: "DW2026081800932", time: "2026-08-18 21:06", sku: "M1906RER", name: "New Balance 1906R", size: "40.5", price: "¥899", state: "已发货" },
  { id: "DW2026081800824", time: "2026-08-18 17:32", sku: "HF3165-401", name: "Nike Air Force 1 蓝白", size: "43", price: "¥689", state: "待发货" },
];

const navItems: { id: Tab; icon: string; label: string }[] = [
  { id: "home", icon: "⌂", label: "首页" },
  { id: "stock", icon: "▣", label: "库存" },
  { id: "orders", icon: "◫", label: "订单" },
  { id: "profile", icon: "○", label: "我的" },
];

function status(count: number) { return count === 0 ? "缺货" : count <= 2 ? "偏低" : "充足"; }

export default function Home() {
  const [tab, setTab] = useState<Tab>("home");
  const [inventory, setInventory] = useState(initialStock);
  const [scanMode, setScanMode] = useState<ScanMode | null>(null);
  const [scanValue, setScanValue] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [stockQuery, setStockQuery] = useState("");
  const [orderQuery, setOrderQuery] = useState("");
  const [sizeFilter, setSizeFilter] = useState("全部尺码");
  const [dateFilter, setDateFilter] = useState("近7天");
  const [showFilters, setShowFilters] = useState(false);
  const [showApi, setShowApi] = useState(false);
  const [appKey, setAppKey] = useState("dw_prod_8f3a••••••••");
  const [appSecret, setAppSecret] = useState("");
  const [connected, setConnected] = useState(true);
  const [toast, setToast] = useState("");

  const visibleStock = useMemo(() => inventory.filter((item) => {
    const q = stockQuery.trim().toLowerCase();
    return !q || `${item.name}${item.sku}${item.size}${item.barcode}`.toLowerCase().includes(q);
  }), [inventory, stockQuery]);

  const visibleOrders = useMemo(() => orders.filter((item) => {
    const q = orderQuery.trim().toLowerCase();
    const matchesQ = !q || `${item.id}${item.name}${item.sku}${item.size}${item.state}`.toLowerCase().includes(q);
    const matchesSize = sizeFilter === "全部尺码" || item.size === sizeFilter;
    return matchesQ && matchesSize;
  }), [orderQuery, sizeFilter]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  function openScan(mode: ScanMode) {
    setScanMode(mode); setScanValue(""); setManualMode(false);
  }

  function submitScan(event: FormEvent) {
    event.preventDefault();
    if (!scanValue.trim()) return;
    const needle = scanValue.trim().toLowerCase();
    const found = inventory.find((item) => item.barcode.toLowerCase() === needle || item.sku.toLowerCase() === needle || (manualMode && orders.some((order) => order.id.toLowerCase() === needle && order.sku === item.sku)));
    if (!found) { notify("未找到匹配商品，请检查条码或订单号"); return; }
    if (scanMode === "out" && found.count === 0) { notify("该商品当前无库存，无法出库"); return; }
    setInventory((items) => items.map((item) => item.sku === found.sku ? { ...item, count: Math.max(0, item.count + (scanMode === "in" ? 1 : -1)) } : item));
    notify(`${found.name} 已${scanMode === "in" ? "入库" : "出库"} 1 件`);
    setScanMode(null);
  }

  const total = inventory.reduce((sum, item) => sum + item.count, 0);

  return (
    <main className="app-shell">
      <Header tab={tab} onApi={() => setShowApi(true)} />

      {tab === "home" && <HomeView total={total} inventory={inventory} onScan={openScan} onTab={setTab} onSync={() => notify("订单同步完成，新增 3 条订单")} />}
      {tab === "stock" && <StockView items={visibleStock} query={stockQuery} setQuery={setStockQuery} onScan={openScan} />}
      {tab === "orders" && <OrdersView items={visibleOrders} query={orderQuery} setQuery={setOrderQuery} date={dateFilter} size={sizeFilter} showFilters={showFilters} setShowFilters={setShowFilters} setDate={setDateFilter} setSize={setSizeFilter} onSync={() => notify("正在从得物开放平台同步订单")} />}
      {tab === "profile" && <ProfileView connected={connected} onApi={() => setShowApi(true)} onAction={notify} />}

      <nav className="bottom-nav" aria-label="主导航">
        {navItems.slice(0, 2).map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><i>{item.icon}</i>{item.label}</button>)}
        <button className="scan-main" aria-label="扫码入库" onClick={() => openScan("in")}><i>⌗</i></button>
        {navItems.slice(2).map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><i>{item.icon}</i>{item.label}</button>)}
      </nav>

      {scanMode && <div className="modal-backdrop">
        <section className="sheet scan-sheet" role="dialog" aria-modal="true" aria-label={scanMode === "in" ? "商品入库" : "商品出库"}>
          <div className="sheet-handle" /><button className="close" onClick={() => setScanMode(null)}>×</button>
          <span className="modal-kicker">{scanMode === "in" ? "INBOUND" : "OUTBOUND"}</span>
          <h2>{scanMode === "in" ? "商品入库" : "商品出库"}</h2>
          <p>扫码枪可直接输入条码并回车，也可以切换为手动输入。</p>
          <div className={`scanner-frame ${scanMode}`}><div className="scan-line" /><b>⌗</b><span>等待扫描商品条码</span></div>
          <form onSubmit={submitScan}>
            <label>{manualMode ? "订单号 / 货号" : "商品条码"}<input value={scanValue} onChange={(e) => setScanValue(e.target.value)} placeholder={manualMode ? "如 DW2026081900186" : "如 194501088343"} /></label>
            <button className="primary wide" type="submit">确认{scanMode === "in" ? "入库" : "出库"}</button>
          </form>
          <button className="text-action" onClick={() => { setManualMode(!manualMode); setScanValue(""); }}>{manualMode ? "切换扫码枪模式" : "手动输入订单号"}</button>
        </section>
      </div>}

      {showApi && <div className="modal-backdrop">
        <section className="sheet api-sheet" role="dialog" aria-modal="true" aria-label="得物开放平台配置">
          <div className="sheet-handle" /><button className="close" onClick={() => setShowApi(false)}>×</button>
          <span className="modal-kicker">DEWU OPEN PLATFORM</span><h2>订单数据连接</h2>
          <p>配置开放平台凭证后，可自动拉取得物账号订单。</p>
          <div className={`connection-card ${connected ? "connected" : ""}`}><i>{connected ? "✓" : "!"}</i><span><b>{connected ? "连接正常" : "尚未连接"}</b><small>{connected ? "最近同步：今天 10:46" : "请输入凭证完成连接"}</small></span></div>
          <form onSubmit={(e) => { e.preventDefault(); if (!appKey || !appSecret) { notify("请完整填写 AppKey 与 AppSecret"); return; } setConnected(true); setShowApi(false); notify("连接验证成功，订单已开始同步"); }}>
            <label>AppKey<input value={appKey} onChange={(e) => setAppKey(e.target.value)} autoComplete="off" /></label>
            <label>AppSecret<input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="输入 AppSecret" autoComplete="new-password" /></label>
            <div className="security-note"><i>⌾</i><span><b>凭证安全</b><small>正式接入时 AppSecret 仅保存在服务端加密环境，不会写入 H5 或浏览器缓存。</small></span></div>
            <button className="primary wide" type="submit">验证并保存</button>
          </form>
        </section>
      </div>}

      {toast && <div className="toast" role="status"><i>✓</i>{toast}</div>}
    </main>
  );
}

function Header({ tab, onApi }: { tab: Tab; onApi: () => void }) {
  const titles: Record<Tab, string> = { home: "骏骏订单", stock: "库存管理", orders: "订单查询", profile: "系统设置" };
  return <header className="topbar"><div className="brand-mark">J</div><div><strong>{titles[tab]}</strong><span>{tab === "home" ? "得物订单管理系统" : "DEWU SELLER CENTER"}</span></div><button className="icon-button" aria-label="数据连接" onClick={onApi}>⌁<i /></button></header>;
}

function HomeView({ total, inventory, onScan, onTab, onSync }: { total: number; inventory: typeof initialStock; onScan: (m: ScanMode) => void; onTab: (t: Tab) => void; onSync: () => void }) {
  return <>
    <section className="hero-card"><div className="hero-copy"><span className="eyebrow">实时库存</span><b>{total}</b><small>件商品在库</small></div><button className="sync-button" onClick={onSync}>↻ 同步</button><div className="hero-stats"><span><b>24</b>今日入库</span><span><b>18</b>今日出库</span></div></section>
    <section className="quick-grid" aria-label="快捷操作"><button onClick={() => onScan("in")}><i className="quick-icon cyan">⌗</i><span><b>扫码入库</b><small>扫描条码或订单号</small></span><em>›</em></button><button onClick={() => onScan("out")}><i className="quick-icon ink">↗</i><span><b>扫码出库</b><small>快速核销库存</small></span><em>›</em></button></section>
    <section className="mini-metrics"><article><span>待发货</span><b>12</b><small>较昨日 +3</small></article><article><span>库存预警</span><b>2</b><small>需要补货</small></article><article><span>今日订单</span><b>36</b><small>成交 ¥26.8k</small></article></section>
    <section className="section-block"><div className="section-title"><div><h2>库存概览</h2><p>实时同步，刚刚更新</p></div><button onClick={() => onTab("stock")}>查看全部</button></div><StockList items={inventory.slice(0, 3)} /></section>
  </>;
}

function StockView({ items, query, setQuery, onScan }: { items: typeof initialStock; query: string; setQuery: (v: string) => void; onScan: (m: ScanMode) => void }) {
  return <section className="page-view"><div className="searchbar"><i>⌕</i><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索货号、商品、尺码或条码" /><button onClick={() => setQuery("")}>{query ? "×" : "筛选"}</button></div><div className="stock-summary"><div><span>总库存</span><b>{items.reduce((s, i) => s + i.count, 0)}</b></div><div><span>SKU 数</span><b>{items.length}</b></div><div><span>库存预警</span><b className="warn">{items.filter(i => i.count <= 2).length}</b></div></div><div className="section-title inventory-title"><div><h2>全部商品</h2><p>按最近变动排序</p></div><div className="inline-actions"><button onClick={() => onScan("in")}>＋ 入库</button><button onClick={() => onScan("out")}>－ 出库</button></div></div>{items.length ? <StockList items={items} detail /> : <Empty title="没有找到商品" text="尝试更换货号、尺码或条码" />}</section>;
}

function StockList({ items, detail = false }: { items: typeof initialStock; detail?: boolean }) {
  return <div className={`stock-list ${detail ? "detailed" : ""}`}>{items.map((item) => <article key={item.sku}><div className="shoe-thumb">{item.name.slice(0, 2)}</div><div className="stock-info"><b>{item.name}</b><small>{item.sku} · {item.size}码 {detail && `· 库位 ${item.location}`}</small></div><div className="stock-count"><b>{item.count}</b><span className={`status ${status(item.count)}`}>{status(item.count)}</span></div></article>)}</div>;
}

function OrdersView({ items, query, setQuery, date, size, showFilters, setShowFilters, setDate, setSize, onSync }: { items: typeof orders; query: string; setQuery: (v: string) => void; date: string; size: string; showFilters: boolean; setShowFilters: (v: boolean) => void; setDate: (v: string) => void; setSize: (v: string) => void; onSync: () => void }) {
  return <section className="page-view"><div className="searchbar"><i>⌕</i><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="订单号、货号或商品名称" /><button onClick={() => setShowFilters(!showFilters)}>筛选</button></div><div className="filter-chips"><button className="active" onClick={() => setShowFilters(!showFilters)}>{date}⌄</button><button className={size !== "全部尺码" ? "active" : ""} onClick={() => setShowFilters(!showFilters)}>{size}⌄</button><button onClick={() => setQuery("待发货")}>待发货</button></div>{showFilters && <div className="filter-panel"><label>时间范围<select value={date} onChange={(e) => setDate(e.target.value)}><option>今天</option><option>近7天</option><option>近30天</option><option>自定义</option></select></label><label>尺码<select value={size} onChange={(e) => setSize(e.target.value)}><option>全部尺码</option>{["38","40.5","41","42","43"].map(v => <option key={v}>{v}</option>)}</select></label><button className="primary" onClick={() => setShowFilters(false)}>应用条件</button></div>}<div className="section-title order-title"><div><h2>订单列表</h2><p>共 {items.length} 条符合条件</p></div><button className="sync-link" onClick={onSync}>↻ 同步订单</button></div><div className="order-list">{items.map(item => <article key={item.id}><div className="order-head"><span>{item.id}</span><b className={`order-state ${item.state}`}>{item.state}</b></div><div className="order-body"><div className="shoe-thumb">{item.name.slice(0,2)}</div><div><b>{item.name}</b><small>{item.sku} · {item.size}码</small><time>{item.time}</time></div><strong>{item.price}</strong></div></article>)}{!items.length && <Empty title="没有符合条件的订单" text="请放宽时间、货号或尺码条件" />}</div></section>;
}

function ProfileView({ connected, onApi, onAction }: { connected: boolean; onApi: () => void; onAction: (m: string) => void }) {
  const rows = [{ icon: "⌁", name: "得物开放平台", info: connected ? "已连接" : "未连接", action: onApi }, { icon: "↻", name: "自动同步", info: "每 15 分钟", action: () => onAction("自动同步频率已设为 15 分钟") }, { icon: "▤", name: "操作记录", info: "查看", action: () => onAction("暂无异常操作记录") }, { icon: "?", name: "帮助与反馈", info: "", action: () => onAction("帮助中心正在建设中") }];
  return <section className="page-view profile-view"><div className="account-card"><div className="avatar">J</div><div><b>骏骏潮品店</b><span>得物卖家 ID · 8831026</span></div><em>认证卖家</em></div><div className="connection-overview"><i className={connected ? "ok" : ""}>{connected ? "✓" : "!"}</i><div><b>订单数据{connected ? "已连接" : "未连接"}</b><span>{connected ? "今日已同步 3 次，共 36 条" : "连接后自动同步得物订单"}</span></div><button onClick={onApi}>{connected ? "管理" : "连接"}</button></div><h3 className="group-label">系统设置</h3><div className="settings-list">{rows.map(row => <button key={row.name} onClick={row.action}><i>{row.icon}</i><span>{row.name}</span><small>{row.info}</small><em>›</em></button>)}</div><p className="version">骏骏订单 v1.0 · 数据安全保护中</p></section>;
}

function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><i>⌕</i><b>{title}</b><span>{text}</span></div>; }
