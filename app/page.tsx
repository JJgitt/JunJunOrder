"use client";

import {FormEvent, useCallback, useEffect, useMemo, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {useRouter} from "next/navigation";
import Image from "next/image";
import {courierTrackingUrl, findOrdersByCourierNo, findTransitCandidatesByCourierTail, normalizeCourierNo} from "@/lib/courier";
import {buildOrderCopyText} from "@/lib/order-copy";
import {dateKey, dayRange, timestamp, waitingLabel, type ServerClock} from "@/lib/time";
import type {KnowledgeMatch} from "@/lib/product-knowledge-match";
import {fillProductIdentity} from "@/lib/product-knowledge-fill";
import ProductKnowledgePanel from "./product-knowledge-panel";
import {ServerClockProvider, useServerClock} from "./server-clock";

type Role = "admin" | "buyer";
type AdminTab = "dashboard" | "stock" | "orders" | "upload" | "profile";
type BuyerTab = "home" | "upload" | "mine";
type OrderStatus = "待审核" | "在途" | "已入库" | "待发货" | "已发货" | "已驳回";
type OrderSortKey = "createdAt" | "receivedAt" | "shippedAt";
type OrderSort = { key: OrderSortKey; direction: "asc" | "desc" } | null;
type Overlay = "receipt" | "scan" | "manual-receive" | "revert-receive" | "detail" | "reject" | "ship" | "settle" | "settlement-amount" | "settlement-proof" | null;
type OrderImage = { id: string; url: string; fileName: string; uploadedBy: string; createdAt: string };

type OrderItem = {
    id: string; title: string; sku: string; size: string; qty: number; amount: number;
    purchaseCourierCompany: string; purchaseCourierNo: string;
    shipped?: boolean; shippedAt?: string; resalePlatform?: string; resaleNo?: string; salePrice?: number; outboundCompany?: string; outboundCourier?: string;
};
type OrderItemDraft = { id: string; title: string; sku: string; size: string; qty: number | ""; amount: string; purchaseCourierCompany: string; customPurchaseCourierCompany: string; purchaseCourierNo: string; knowledgeHint?: KnowledgeMatch };

type PurchaseOrder = {
    id: string; platform: string; platformNo: string; courierCompany: string; courierNo: string; status: OrderStatus;
    purchaser: string; purchaserId?: string; purchaserPhone?: string; purchaserWechatId?: string; createdAt: string; approvedAt?: string; location?: string; receivedAt?: string; rejectReason?: string;
    settled: boolean; settledAt?: string; settledByName?: string; settledAmount?: number;
    title: string; itemCount: number; amount: number; items: OrderItem[];
    images: OrderImage[]; settlementProofs: OrderImage[];
};

type RecognizedOrder = { platform: string; platformNo: string; courierCompany: string; courierNo: string; items: Array<{ title: string; sku: string; skuSource?: "explicit" | "specification" | "title"; size: string; qty: number; amount: number | null }>; knowledgeMatches?: KnowledgeMatch[]; notes: string[] };
type StockItem = { sku: string; title: string; size: string; count: number; locations: string[]; lastSold?: string };
type DashboardNotice = { id: string; content: string; noticeDate: string; completed: boolean; completedAt?: string | null; createdAt: string };
type ApprovalStatus = "pending" | "approved" | "rejected";
type AppUser = { id: string; wechatId: string; phone: string; name: string; role: Role; active: boolean; approvalStatus: ApprovalStatus };
type Snapshot = { clock: ServerClock; user: AppUser; orders: PurchaseOrder[]; stock: StockItem[]; notices: DashboardNotice[]; users: AppUser[] };

const statusTone: Record<OrderStatus, string> = {
    "待审核": "gray",
    "在途": "orange",
    "已入库": "purple",
    "待发货": "purple",
    "已发货": "green",
    "已驳回": "red"
};
const readyToShip = (status: OrderStatus) => status === "已入库" || status === "待发货";
const canRejectOrder = (order: PurchaseOrder) => !order.settled && ["待审核", "在途", "已入库", "待发货"].includes(order.status) && !order.items.some(item => item.shipped);
const buyerCanEditOrder = (status: OrderStatus) => status === "待审核" || status === "在途" || status === "已驳回";
const statusLabel = (status: OrderStatus) => readyToShip(status) ? "待发货" : status;
const money = (value: number) => `¥${value.toLocaleString("zh-CN", {minimumFractionDigits: 2})}`;
/** 商品行金额是整行实付合计；多件时按数量折算单价，保留两位小数。 */
const unitPrice = (item: { amount: number; qty: number }) => item.qty > 0 ? Math.round(item.amount / item.qty * 100) / 100 : item.amount;
/** 每个商品行代表一种款式，件数是所有款式数量之和。 */
const orderQuantity = (order: PurchaseOrder) => order.items.reduce((sum, item) => sum + item.qty, 0);
const orderTitleWithQuantity = (order: PurchaseOrder) => {
    const quantity = orderQuantity(order);
    return order.itemCount > 1
        ? `${order.title} 等${order.itemCount}款 · 共${quantity}件`
        : `${order.title} · ${order.items[0]?.size}码${quantity > 1 ? `等${quantity}件` : ""}`;
};
/** 金额使用订单实付总额，不能再乘数量，否则会重复计算。 */
const orderListSummary = (list: PurchaseOrder[]) => `${list.length} 笔 · ${list.reduce((sum, order) => sum + orderQuantity(order), 0)} 件 · 金额 ${money(list.reduce((sum, order) => sum + order.amount, 0))}`;
const orderSortOptions: Array<{ key: OrderSortKey; label: string }> = [
    {key: "createdAt", label: "上传时间"},
    {key: "receivedAt", label: "入库时间"},
    {key: "shippedAt", label: "发货时间"}
];
const validTimestamp = (value?: string) => {
    const parsed = value ? timestamp(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
};
const orderSortTimestamp = (order: PurchaseOrder, key: OrderSortKey) => {
    if (key === "createdAt") return validTimestamp(order.createdAt);
    if (key === "receivedAt") return validTimestamp(order.receivedAt);
    const shippedTimes = order.items.map(item => validTimestamp(item.shippedAt)).filter((value): value is number => value !== null);
    return shippedTimes.length ? Math.max(...shippedTimes) : null;
};
const sortPurchaseOrders = (orders: PurchaseOrder[], sort: OrderSort) => {
    if (!sort) return orders;
    return [...orders].sort((left, right) => {
        const leftTime = orderSortTimestamp(left, sort.key), rightTime = orderSortTimestamp(right, sort.key);
        if (leftTime === null || rightTime === null) return leftTime === rightTime ? 0 : leftTime === null ? 1 : -1;
        return sort.direction === "asc" ? leftTime - rightTime : rightTime - leftTime;
    });
};
/** 未选任何状态时显示全部；「待发货」同时匹配已入库与待发货。 */
const matchesStatusFilter = (order: PurchaseOrder, statuses: string[]) => !statuses.length || statuses.some(status => status === "待发货" ? readyToShip(order.status) : order.status === status);
const toggleStatusFilter = (current: string[], value: string) => value === "全部" ? [] : current.includes(value) ? current.filter(item => item !== value) : [...current, value];
const courierCompanies = ["顺丰速运", "京东物流", "中通快递", "圆通速递", "申通快递", "韵达快递", "极兔速递", "邮政EMS"] as const;
const purchaseChannels = ["京东", "淘宝", "抖音", "唯品会", "拼多多", "其他"] as const;
const courierCompanyChoice = (value?: string) => value && courierCompanies.some(company => company === value) ? value : value ? "其他" : "顺丰速运";
const emptyOrderItemDraft = (): OrderItemDraft => ({
    id: "",
    title: "",
    sku: "",
    size: "",
    qty: 1,
    amount: "",
    purchaseCourierCompany: "顺丰速运",
    customPurchaseCourierCompany: "",
    purchaseCourierNo: ""
});
const resolvedPurchaseCourierCompany = (item: OrderItemDraft) => item.purchaseCourierCompany === "其他" ? item.customPurchaseCourierCompany.trim() : item.purchaseCourierCompany;
/** 识图结果写到商品行的采购物流；没有商品时只改快递，不新增商品行。 */
const applyRecognizedCourier = (item: OrderItemDraft, company: string, courierNo: string): OrderItemDraft => {
    const recognizedCompany = company ? courierCompanyChoice(company) : item.purchaseCourierCompany;
    return {
        ...item,
        ...(company ? {
            purchaseCourierCompany: recognizedCompany,
            customPurchaseCourierCompany: recognizedCompany === "其他" ? company : ""
        } : {}),
        ...(courierNo ? {purchaseCourierNo: courierNo} : {})
    };
};

async function copyText(value: string) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("复制失败");
}

export default function Home() {
    const router = useRouter();
    const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
    const [clock, setClock] = useState<ServerClock | null>(null);
    const [people, setPeople] = useState<AppUser[]>([]);
    const [adminTab, setAdminTab] = useState<AdminTab>("dashboard");
    const [buyerTab, setBuyerTab] = useState<BuyerTab>("home");
    const [orders, setOrders] = useState<PurchaseOrder[]>([]);
    const [stock, setStock] = useState<StockItem[]>([]);
    const [notices, setNotices] = useState<DashboardNotice[]>([]);
    const [overlay, setOverlay] = useState<Overlay>(null);
    const [selectedId, setSelectedId] = useState("");
    const [selectedItemId, setSelectedItemId] = useState("");
    const [uploadNonce, setUploadNonce] = useState(0);
    const [toast, setToast] = useState("");
    const [loading, setLoading] = useState(true);
    const [fatalError, setFatalError] = useState("");

    const selected = orders.find(order => order.id === selectedId) ?? orders[0];
    const recentLocations = useMemo(() => Array.from(new Set([...orders].filter(order => order.location).sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? "")).map(order => order.location!.trim()).filter(Boolean))).slice(0, 12), [orders]);
    const notify = (text: string) => {
        setToast(text);
        window.setTimeout(() => setToast(""), 2200);
    };
    const openOrder = (id: string) => {
        setSelectedId(id);
        setOverlay("detail");
    };
    /** 开始一笔新订单时清掉上次选中的订单，并换 key 让录入表单重新挂载。 */
    const startNewUpload = () => {
        setSelectedId("");
        setUploadNonce(value => value + 1);
    };
    const applySnapshot = useCallback((data: Snapshot) => {
        setClock(data.clock);
        setCurrentUser(data.user);
        setPeople(data.users);
        setOrders(data.orders);
        setStock(data.stock);
        setNotices(data.notices);
    }, []);
    const load = useCallback(async () => {
        setLoading(true);
        setFatalError("");
        try {
            const response = await fetch("/api/app", {cache: "no-store"});
            if (response.status === 401) {
                router.replace("/login");
                return;
            }
            const json = await response.json() as Snapshot & { error?: string };
            if (!response.ok) throw new Error(json.error || "加载失败");
            applySnapshot(json);
        } catch (error) {
            setFatalError(error instanceof Error ? error.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, [applySnapshot, router]);
    useEffect(() => {
        const timer = window.setTimeout(() => {
            void load();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [load]);

    async function mutate(action: string, payload: Record<string, unknown> = {}) {
        const response = await fetch("/api/app", {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({action, ...payload})
        });
        if (response.status === 401) {
            router.replace("/login");
            throw new Error("登录已过期");
        }
        const json = await response.json() as { data: Snapshot; createdOrderId?: string; deletedCount?: number; shippedCount?: number; settledCount?: number; deletedUserName?: string; error?: string };
        if (!response.ok) throw new Error(json.error || "操作失败");
        applySnapshot(json.data);
        return json;
    }

    async function refreshOrderData() {
        try {
            const response = await fetch("/api/app", {cache: "no-store"});
            if (response.status === 401) {
                router.replace("/login");
                throw new Error("登录已过期");
            }
            const json = await response.json() as Snapshot & { error?: string };
            if (!response.ok) throw new Error(json.error || "刷新失败");
            applySnapshot(json);
            notify("订单数据已刷新");
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "刷新失败");
            return false;
        }
    }

    async function createNotice(content: string, noticeDate: string) {
        try {
            await mutate("create-dashboard-notice", {content, noticeDate});
            notify("注意事项已添加");
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "添加失败");
            return false;
        }
    }

    async function updateNotice(noticeId: string, content: string, noticeDate: string) {
        try {
            await mutate("update-dashboard-notice", {noticeId, content, noticeDate});
            notify("注意事项已更新");
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "编辑失败");
            return false;
        }
    }

    async function setNoticeCompleted(noticeId: string, completed: boolean) {
        try {
            await mutate("set-dashboard-notice-completed", {noticeId, completed});
            notify(completed ? "已标记完成" : "已恢复为未完成");
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "更新失败");
            return false;
        }
    }

    async function uploadOrderFiles(orderId: string, files: File[]) {
        const form = new FormData();
        form.set("orderId", orderId);
        files.forEach(file => form.append("files", file));
        const response = await fetch("/api/order-images", {method: "POST", body: form});
        if (!response.ok) {
            const json = await response.json() as { error?: string };
            throw new Error(json.error ?? "图片上传失败");
        }
    }

    async function run(action: string, payload: Record<string, unknown>, success: string) {
        try {
            await mutate(action, payload);
            setOverlay(null);
            notify(success);
        } catch (error) {
            notify(error instanceof Error ? error.message : "操作失败");
        }
    }

    const approve = (id: string) => void run("approve", {orderId: id}, "订单审核通过，已进入在途状态");
    const reject = (id: string, reason: string) => void run("reject", {orderId: id, reason}, "订单已驳回，采购员将收到提醒");
    async function settleOrder(id: string, amount?: number, proof?: File) {
        try {
            const form = new FormData();
            form.set("orderId", id);
            if (amount != null) form.set("amount", String(amount));
            if (proof) {
                form.set("proofSelected", "true");
                form.append("proof", proof, proof.name);
            }
            const response = await fetch("/api/settlements", {method: "POST", body: form});
            if (response.status === 401) {
                router.replace("/login");
                throw new Error("登录已过期");
            }
            const json = await response.json() as { error?: string; amount?: number; proofUploaded?: boolean };
            if (!response.ok) throw new Error(json.error || "结款失败");
            await load();
            setOverlay(null);
            notify(json.proofUploaded ? "采购单已结款，结款凭证已保存" : "采购单已完成结款，发货状态保持不变");
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "结款失败");
            return false;
        }
    }

    async function updateSettlementProof(id: string, proof: File, amount?: number | null) {
        try {
            const form = new FormData();
            form.set("orderId", id);
            form.append("proof", proof, proof.name);
            if (amount !== undefined) form.set("amount", amount === null ? "" : String(amount));
            const response = await fetch("/api/settlements/proof", {method: "POST", body: form});
            if (response.status === 401) {
                router.replace("/login");
                throw new Error("登录已过期");
            }
            const json = await response.json() as { error?: string; replaced?: boolean };
            if (!response.ok) throw new Error(json.error || "结款截图上传失败");
            await load();
            setOverlay(null);
            notify(`${json.replaced ? "结款截图已更换" : "结款截图已补充"}${amount !== undefined ? "，金额已更新" : ""}`);
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "结款截图上传失败");
            return false;
        }
    }

    async function updateSettlementAmount(id: string, amount?: number) {
        try {
            await mutate("update-settlement-amount", {orderId: id, amount: amount == null ? "" : String(amount)});
            setOverlay(null);
            notify(amount == null ? "结款金额已清空" : "结款金额已更新");
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "结款金额更新失败");
            return false;
        }
    }

    async function receive(id: string, location: string, files: File[] = []) {
        try {
            await mutate("receive", {orderId: id, location});
        } catch (error) {
            notify(error instanceof Error ? error.message : "入库失败");
            return;
        }
        if (files.length) {
            try {
                await uploadOrderFiles(id, files);
                await load();
            } catch (error) {
                setOverlay(null);
                notify(`入库成功，但截图上传失败：${error instanceof Error ? error.message : "未知错误"}`);
                return;
            }
        }
        setOverlay(null);
        notify(files.length ? "收货入库完成，截图已保存" : "收货入库完成，库存已更新");
    }

    const ship = (itemId: string, shipped: boolean, resaleNo: string, salePrice: number, courier: string, company: string, resalePlatform: string) => void run(shipped ? "update-shipping" : "ship", {
        itemId,
        resaleNo,
        salePrice,
        courier,
        company,
        resalePlatform
    }, shipped ? "预估售价与发货物流已更新" : "发货完成，库存已自动扣减");

    async function batchShip(shipments: Array<{ orderId: string; courier: string; company: string }>) {
        try {
            const result = await mutate("batch-ship", {shipments});
            notify(`已完成 ${result.shippedCount ?? shipments.length} 笔订单发货`);
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "批量发货失败");
            return false;
        }
    }

    async function batchSettle(ids: string[]) {
        try {
            const result = await mutate("batch-settle", {orderIds: ids});
            notify(`已完成 ${result.settledCount ?? ids.length} 笔订单结款`);
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "批量结款失败");
            return false;
        }
    }

    async function deleteOrders(ids: string[]) {
        try {
            const result = await mutate("delete-orders", {orderIds: ids});
            notify(`已删除 ${result.deletedCount ?? ids.length} 笔订单`);
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "删除失败");
            return false;
        }
    }

    async function revertReceive(id: string) {
        try {
            await mutate("revert-receive", {orderId: id});
            setOverlay(null);
            notify("订单已退回在途，库存已回滚");
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "退回在途失败");
            return false;
        }
    }

    async function resetPassword(userId: string, password: string) {
        try {
            await mutate("reset-user-password", {userId, password});
            notify("成员密码已重置");
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "重置密码失败");
            return false;
        }
    }

    async function deleteUser(userId: string) {
        try {
            const result = await mutate("delete-user", {userId});
            notify(`采购员${result.deletedUserName ? ` ${result.deletedUserName} ` : ""}已删除`);
            return true;
        } catch (error) {
            notify(error instanceof Error ? error.message : "删除成员失败");
            return false;
        }
    }

    async function upload(order: PurchaseOrder, files: File[]) {
        try {
            const editing = orders.find(item => item.id === order.id);
            const action = editing ? (currentUser?.role === "admin" ? "update-order" : "resubmit-order") : "create-order";
            const result = await mutate(action, {
                ...(editing ? {orderId: order.id} : {}),
                ...(editing && currentUser?.role === "admin" ? {purchaserId: order.purchaserId} : {}),
                platform: order.platform,
                platformNo: order.platformNo,
                courierCompany: order.courierCompany,
                courierNo: order.courierNo,
                items: order.items.map(item => ({
                    id: item.id,
                    title: item.title,
                    sku: item.sku,
                    size: item.size,
                    qty: item.qty,
                    amount: item.amount,
                    purchaseCourierCompany: item.purchaseCourierCompany,
                    purchaseCourierNo: item.purchaseCourierNo
                }))
            });
            if (files.length && result.createdOrderId) {
                try {
                    await uploadOrderFiles(result.createdOrderId, files);
                    await load();
                } catch (error) {
                    throw new Error(`订单已保存，但图片上传失败：${error instanceof Error ? error.message : "未知错误"}`);
                }
            }
            if (!editing) {
                setSelectedId("");
                setUploadNonce(value => value + 1);
            }
            if (currentUser?.role === "admin") setAdminTab("orders"); else setBuyerTab("mine");
            notify(editing ? (currentUser?.role === "admin" ? "订单信息已更新" : editing.status === "已驳回" ? "订单已修改并重新提交审核" : "采购订单信息已更新") : currentUser?.role === "admin" ? "采购订单已创建，可在订单列表继续审核" : "订单提交成功，等待管理员审核");
        } catch (error) {
            notify(error instanceof Error ? error.message : "提交失败");
        }
    }

    if (loading) return <main className="app-frame system-state">
        <div className="system-loader"/>
        <h2>正在连接业务数据</h2><p>正在验证登录状态并载入订单、库存与权限。</p></main>;
    if (fatalError || !currentUser || !clock) return <main className="app-frame system-state">
        <div className="system-error">!</div>
        <h2>系统暂时不可用</h2><p>{fatalError || "无法识别当前用户"}</p>
        <button className="primary-button" onClick={() => void load()}>重新连接</button>
    </main>;
    const role = currentUser.role;

    return <ServerClockProvider initial={clock}><main className="app-frame">
        <AppHeader user={currentUser} page={role === "admin" ? adminTab : buyerTab}/>

        <div className="page-stage">
            {role === "admin" && adminTab === "dashboard" &&
                <AdminDashboard orders={orders} stock={stock} notices={notices} onAddNotice={createNotice} onUpdateNotice={updateNotice} onSetNoticeCompleted={setNoticeCompleted} onCreate={() => {
                    startNewUpload();
                    setAdminTab("upload");
                }} onReceipt={() => setOverlay("receipt")} onOrders={() => setAdminTab("orders")}
                                onStock={() => setAdminTab("stock")}/>}
            {role === "admin" && adminTab === "stock" &&
                <StockPage stock={stock} onSuggest={() => notify("已生成 3 条采购建议")}/>}
            {role === "admin" && adminTab === "orders" && <AdminOrders orders={orders} onCreate={() => {
                startNewUpload();
                setAdminTab("upload");
            }} onEdit={(id) => {
                setSelectedId(id);
                setAdminTab("upload");
            }} onRefresh={refreshOrderData} onDelete={deleteOrders} onBatchShip={batchShip} onBatchSettle={batchSettle} onOpen={openOrder} onApprove={approve} onNotify={notify}
                                                                       onReceive={(id) => {
                                                                           setSelectedId(id);
                                                                           setOverlay("manual-receive");
                                                                       }} onReject={(id) => {
                setSelectedId(id);
                setOverlay("reject");
            }} onShip={(id) => {
                setSelectedId(id);
                setOverlay("detail");
            }} onSettle={(id) => {
                setSelectedId(id);
                setOverlay("settle");
            }}/>}

            {role === "admin" && adminTab === "upload" &&
                <UploadPage key={`upload-${selectedId || "new"}-${uploadNonce}`} mode="admin"
                            people={people}
                            editing={orders.find(item => item.id === selectedId)} onCancel={() => setAdminTab("orders")}
                            onSubmit={upload}/>}
            {role === "admin" && adminTab === "profile" && <AdminProfile user={currentUser} people={people}
                                                                         onRole={(userId, nextRole) => void run("set-user-role", {
                                                                             userId,
                                                                             role: nextRole
                                                                         }, "用户角色已更新")}
                                                                         onActive={(userId, active) => void run("set-user-active", {
                                                                             userId,
                                                                             active
                                                                         }, active ? "账号已启用" : "账号已停用")}
                                                                         onCreate={(member) => void run("create-user", member, "成员账号已创建")}
                                                                         onReview={(userId, decision) => void run("review-user-application", {
                                                                             userId,
                                                                             decision
                                                                         }, decision === "approve" ? "采购员申请已通过" : "采购员申请已拒绝")}
                                                                         onResetPassword={resetPassword}
                                                                         onDeleteUser={deleteUser} onNotify={notify}/>}

            {role === "buyer" && buyerTab === "home" &&
                <BuyerHome buyerName={currentUser.name} orders={orders} onUpload={() => {
                    startNewUpload();
                    setBuyerTab("upload");
                }} onMine={() => setBuyerTab("mine")} onEdit={(id) => {
                    setSelectedId(id);
                    setBuyerTab("upload");
                }}/>}
            {role === "buyer" && buyerTab === "upload" &&
                <UploadPage key={`upload-${selectedId || "new"}-${uploadNonce}`} mode="buyer"
                            editing={orders.find(item => item.id === selectedId && buyerCanEditOrder(item.status))}
                            onSubmit={upload}/>}
            {role === "buyer" && buyerTab === "mine" &&
                <BuyerOrders orders={orders} onOpen={openOrder} onEdit={(id) => {
                    setSelectedId(id);
                    setBuyerTab("upload");
                }}/>}
        </div>

        {((role === "admin" && adminTab === "orders") || (role === "buyer" && buyerTab === "mine")) &&
            <ScrollToTopButton/>}
        {role === "admin" ? <AdminNav active={adminTab} onChange={setAdminTab} onScan={() => setOverlay("scan")}/> :
            <BuyerNav active={buyerTab} onChange={(tab) => {
                if (tab === "upload") startNewUpload();
                setBuyerTab(tab);
            }}/>}

        {role === "admin" && overlay === "receipt" &&
            <ReceiptSheet orders={orders} recentLocations={recentLocations} onClose={() => setOverlay(null)} onReceive={receive}
                          onManual={() => setOverlay("scan")} onNotify={notify}/>}
        {role === "admin" && overlay === "scan" &&
            <ScanSheet orders={orders} recentLocations={recentLocations} onClose={() => setOverlay(null)} onReceive={receive} onNotify={notify}/>}
        {role === "admin" && overlay === "manual-receive" && selected &&
            <ManualReceiveSheet order={selected} recentLocations={recentLocations} onClose={() => setOverlay(null)}
                                onSubmit={receive}/>}
        {overlay === "detail" && selected &&
            <OrderDetail order={selected} canManage={role === "admin"} showLocation={role === "admin"}
                         onClose={() => setOverlay(null)} onApprove={() => approve(selected.id)}
                         onReceive={() => setOverlay("manual-receive")}
                         onRevertReceive={() => setOverlay("revert-receive")} onReject={() => setOverlay("reject")}
                         onSettle={() => setOverlay("settle")}
                         onSettlementAmount={() => setOverlay("settlement-amount")}
                         onSettlementProof={() => setOverlay("settlement-proof")}
                         onShipItem={(itemId) => {
                             setSelectedItemId(itemId);
                             setOverlay("ship");
                         }}/>}
        {role === "admin" && overlay === "revert-receive" && selected &&
            <RevertReceiveSheet order={selected} onClose={() => setOverlay(null)} onSubmit={revertReceive}/>}
        {role === "admin" && overlay === "reject" && selected &&
            <RejectSheet order={selected} onClose={() => setOverlay(null)} onSubmit={reject}/>}
        {role === "admin" && overlay === "settle" && selected &&
            <SettlementSheet order={selected} onClose={() => setOverlay(null)} onSubmit={settleOrder}/>}
        {role === "admin" && overlay === "settlement-amount" && selected &&
            <SettlementAmountSheet order={selected} onClose={() => setOverlay(null)} onSubmit={updateSettlementAmount}/>}
        {role === "admin" && overlay === "settlement-proof" && selected &&
            <SettlementProofSheet order={selected} onClose={() => setOverlay(null)} onSubmit={updateSettlementProof}/>}
        {role === "admin" && overlay === "ship" && selected && selected.items.length > 0 && <ShipSheet order={selected}
                                                                                                       item={selected.items.find(item => item.id === selectedItemId) ?? selected.items[0]}
                                                                                                       onClose={() => setOverlay(null)}
                                                                                                       onSubmit={ship}/>}
        {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </main></ServerClockProvider>;
}

function AppHeader({user, page}: { user: AppUser; page: string }) {
    const {timeZone} = useServerClock();
    const labels: Record<string, string> = {
        dashboard: "管理看板",
        stock: "库存管理",
        orders: "订单管理",
        profile: "我的",
        home: "鸿运采购",
        upload: "采购订单录入",
        mine: "我的订单"
    };
    return <header className="app-header">
        <div className="logo">鸿</div>
        <div className="header-copy"><h1>{labels[page]}</h1>
            <span>{user.role === "admin" ? "管理员" : "采购员"} · 服务器时区 {timeZone}</span></div>
        <div className="identity-pill"><b>{user.name.slice(0, 1)}</b><span>{user.wechatId}</span><a
            className="identity-logout" href="/api/auth/logout">退出</a></div>
    </header>;
}

function AdminDashboard({
                             orders,
                             stock,
                             notices,
                             onAddNotice,
                             onUpdateNotice,
                             onSetNoticeCompleted,
                             onCreate,
                            onReceipt,
                            onOrders,
                            onStock
                         }: { orders: PurchaseOrder[]; stock: StockItem[]; notices: DashboardNotice[]; onAddNotice: (content: string, noticeDate: string) => Promise<boolean>; onUpdateNotice: (id: string, content: string, noticeDate: string) => Promise<boolean>; onSetNoticeCompleted: (id: string, completed: boolean) => Promise<boolean>; onCreate: () => void; onReceipt: () => void; onOrders: () => void; onStock: () => void }) {
    const [noticeDraft, setNoticeDraft] = useState("");
    const [noticeBusy, setNoticeBusy] = useState(false);
    const {now, timeZone} = useServerClock();
    const today = dateKey(now, timeZone);
    const [noticeDate, setNoticeDate] = useState(today);
    const [editingNoticeId, setEditingNoticeId] = useState<string | null>(null);
    const [editContent, setEditContent] = useState("");
    const [editDate, setEditDate] = useState("");
    const pendingOrders = orders.filter(o => o.status === "待审核");
    const earliest = pendingOrders.map(o => o.createdAt).sort((a,b) => timestamp(a)-timestamp(b))[0];
    const pending = pendingOrders.length;
    const transit = orders.filter(o => o.status === "在途").length;
    const shipping = orders.filter(o => readyToShip(o.status)).length;
    const inToday = orders.filter(o => o.receivedAt && dateKey(o.receivedAt, timeZone) === today).length;
    const purchase = orders.reduce((sum, o) => sum + o.amount, 0);
    const sales = orders.reduce((sum, o) => sum + o.items.reduce((s, i) => s + (i.salePrice ?? 0), 0), 0);
    async function submitNotice(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const content = noticeDraft.trim();
        if (!content || !noticeDate || noticeBusy) return;
        setNoticeBusy(true);
        try {
            if (await onAddNotice(content, noticeDate)) setNoticeDraft("");
        } finally {
            setNoticeBusy(false);
        }
    }
    function startEditNotice(notice: DashboardNotice) {
        setEditingNoticeId(notice.id);
        setEditContent(notice.content);
        setEditDate(notice.noticeDate);
    }
    async function saveNotice(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const content = editContent.trim();
        if (!editingNoticeId || !content || !editDate || noticeBusy) return;
        setNoticeBusy(true);
        try {
            if (await onUpdateNotice(editingNoticeId, content, editDate)) setEditingNoticeId(null);
        } finally {
            setNoticeBusy(false);
        }
    }
    async function toggleNotice(notice: DashboardNotice) {
        if (noticeBusy) return;
        setNoticeBusy(true);
        try {
            await onSetNoticeCompleted(notice.id, !notice.completed);
        } finally {
            setNoticeBusy(false);
        }
    }
    return <section className="dashboard-page enter">
        <div className="date-row">
            <div><span>{new Intl.DateTimeFormat("zh-CN", {timeZone, month:"long", day:"numeric", weekday:"short"}).format(now)}</span><h2>采购管理看板</h2></div>
            <button aria-label="通知">🔔<i/></button>
        </div>
        <div className="stat-grid">
            <button onClick={onOrders}><b>{pending}</b><span>待审核</span><em>需处理</em></button>
            <button onClick={onReceipt}><b>{transit}</b><span>在途</span><em>待收货</em></button>
            <button onClick={onOrders}><b>{shipping}</b><span>待发货</span><em>更新信息</em></button>
            <button><b>{inToday}</b><span>今日入库</span><em>按服务器日期</em></button>
        </div>
        <button className="admin-create-entry" onClick={onCreate}>
            <i>＋</i><span><b>新增采购订单</b><small>管理员可直接录入采购与物流信息</small></span><em>立即创建 ›</em></button>
        <div className="receipt-hero">
            <div className="receipt-icon">📷</div>
            <div><span>推荐收货方式</span><h3>拍照识别快递面单</h3><p>自动识别单号，反查货品、订单与采购员</p></div>
            <button onClick={onReceipt}>开始识别</button>
        </div>
        <SectionHead title="待办事项" note={`${pending + transit + shipping} 项待处理`}/>
        <div className="task-card"><Task icon="📦" tone="green" title={`${transit} 笔在途待收货`} note="按快递单号自动关联采购订单"
                                         action="拍照识别" onClick={onReceipt}/><Task icon="✓" tone="orange"
                                                                                  title={`${pending} 笔新订单待审核`}
                                                                                  note={waitingLabel(earliest, now)} action="去审核"
                                                                                  onClick={onOrders}/><Task icon="🚚"
                                                                                                            tone="purple"
                                                                                                            title={`${shipping} 笔已入库待发货`}
                                                                                                            note="填写得物单号、售价和发货快递"
                                                                                                            action="更新发货"
                                                                                                            onClick={onOrders}/><Task
            icon="!" tone="blue" title={`${stock.filter(s => s.count <= 2).length} 个 SKU 库存偏低`} note="建议生成补货清单"
            action="查看" onClick={onStock}/></div>
        <section className="dashboard-notices" aria-label="注意事项清单">
            <div className="dashboard-notices-head"><h3>注意事项清单</h3><span>{notices.filter(notice => !notice.completed).length} 项未完成</span></div>
            <form className="dashboard-notice-form" onSubmit={submitNotice}>
                <input aria-label="新增注意事项" placeholder="填写需要记住或处理的事项" value={noticeDraft}
                       maxLength={300} onChange={event => setNoticeDraft(event.target.value)}/>
                <input type="date" aria-label="事项日期" required value={noticeDate}
                       onChange={event => setNoticeDate(event.target.value)}/>
                <button type="submit" disabled={noticeBusy || !noticeDraft.trim() || !noticeDate}>添加</button>
            </form>
            {notices.length ? <ul className="dashboard-notice-list">{notices.map(notice =>
                <li key={notice.id} className={notice.completed ? "completed" : ""}>
                    {editingNoticeId === notice.id ? <form className="dashboard-notice-edit" onSubmit={saveNotice}>
                        <input aria-label="编辑事项内容" maxLength={300} required value={editContent}
                               onChange={event => setEditContent(event.target.value)}/>
                        <input type="date" aria-label="编辑事项日期" required value={editDate}
                               onChange={event => setEditDate(event.target.value)}/>
                        <div className="dashboard-notice-edit-actions">
                            <button type="button" disabled={noticeBusy} onClick={() => setEditingNoticeId(null)}>取消</button>
                            <button type="submit" disabled={noticeBusy || !editContent.trim() || !editDate}>保存</button>
                        </div>
                    </form> : <div className="dashboard-notice-row">
                        <label><input type="checkbox" checked={notice.completed} disabled={noticeBusy}
                                      onChange={() => void toggleNotice(notice)}/><span className="sr-only">标记事项完成</span>
                            <span className="dashboard-notice-info"><span className="dashboard-notice-text">{notice.content}</span>
                                <time dateTime={notice.noticeDate}>{notice.noticeDate}</time></span></label>
                        <button type="button" className="dashboard-notice-edit-button" disabled={noticeBusy}
                                onClick={() => startEditNotice(notice)}>编辑</button>
                    </div>}
                </li>)}</ul> : <p className="dashboard-notice-empty">暂无注意事项，添加后会保存在数据库中。</p>}
        </section>
        <SectionHead title="订单概览" note="当前已加载订单"/>
        <div className="finance-card">
            <div><span>采购总额</span><b>{money(purchase)}</b></div>
            <div><span>销售总额</span><b>{money(sales)}</b></div>
            <div className="profit">
                <span>毛利润（估）</span><b>{money(Math.max(0, sales - orders.reduce((s, o) => s + o.items.filter(i => i.salePrice).reduce((x, i) => x + i.amount, 0), 0)))}</b>
            </div>
        </div>
    </section>;
}

function SectionHead({title, note}: { title: string; note: string }) {
    return <div className="section-head"><h3>{title}</h3><span>{note}</span></div>;
}

function StatusFilter({
                          options,
                          value,
                          onChange
                      }: { options: readonly string[]; value: string[]; onChange: (next: string[]) => void }) {
    return <div className="status-filter">
        <div className="chip-row scroll" role="group" aria-label="按状态筛选，可多选">
            {options.map(option => {
                const active = option === "全部" ? value.length === 0 : value.includes(option);
                return <button key={option} type="button" className={active ? "active" : ""} aria-pressed={active}
                               onClick={() => onChange(toggleStatusFilter(value, option))}>{option}</button>;
            })}
        </div>
        {value.length > 0 && <div className="status-filter-summary" role="status" aria-live="polite">
            <i className="status-filter-mark" aria-hidden="true">✓</i>
            <div className="status-filter-copy"><span>当前筛选</span><b>已选 <em>{value.length}</em> 个状态</b></div>
            <button type="button" className="status-filter-clear" onClick={() => onChange([])}><span>清除筛选</span><i
                aria-hidden="true">×</i></button>
            <div className="status-filter-values" aria-label="已选择的状态">{value.map(status => <span
                key={status}>{status}</span>)}</div>
        </div>}
    </div>;
}

function Task({
                  icon,
                  tone,
                  title,
                  note,
                  action,
                  onClick
              }: { icon: string; tone: string; title: string; note: string; action: string; onClick: () => void }) {
    return <button className="task-row" onClick={onClick}><i
        className={tone}>{icon}</i><span><b>{title}</b><small>{note}</small></span><em>{action} ›</em></button>;
}

function StockPage({stock, onSuggest}: { stock: StockItem[]; onSuggest: () => void }) {
    const {dateTime} = useServerClock();
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState("全部");
    const visible = stock.filter(item => {
        const tone = item.count === 0 ? "缺货" : item.count <= 2 ? "偏低" : "充足";
        return (filter === "全部" || filter === tone) && `${item.sku}${item.title}${item.size}`.toLowerCase().includes(query.toLowerCase());
    });
    return <section className="enter"><Search value={query} onChange={setQuery} placeholder="搜索货号 / 商品名 / 尺码"
                                              historyKey="stock"/>
        <div className="chip-row">{["全部", "充足", "偏低", "缺货"].map(v => <button key={v}
                                                                             className={filter === v ? "active" : ""}
                                                                             onClick={() => setFilter(v)}>{v}</button>)}</div>
        <div className="stock-overview">
            <div><span>在库总数</span><b>{stock.reduce((s, i) => s + i.count, 0)}</b></div>
            <div><span>SKU 数</span><b>{stock.length}</b></div>
            <div><span>库存预警</span><b className="danger-number">{stock.filter(s => s.count <= 2).length}</b></div>
        </div>
        <SectionHead title="SKU 库存" note={`${visible.length} 条结果`}/>
        <div className="sku-list">{visible.map(item => {
            const tone = item.count === 0 ? "red" : item.count <= 2 ? "orange" : "green";
            const label = item.count === 0 ? "缺货" : item.count <= 2 ? "偏低" : "充足";
            return <article key={`${item.sku}${item.size}`}>
                <div className="product-monogram">{item.title.slice(0, 2)}</div>
                <div className="sku-main">
                    <div>
                        <div className="sku-title"><CopyNumber value={item.sku}
                                                               label="商品货号"/><span>· {item.title}</span></div>
                        <Badge tone={tone}>{label}</Badge></div>
                    <p>{item.size}码 · 库存 <b>{item.count}</b> 件</p>
                    <small>{item.locations.length ? `库位 ${item.locations.join(" / ")}` : item.lastSold ? `最近售出 ${dateTime(item.lastSold)}` : "暂无库位记录"}</small>
                </div>
                {item.count === 0 && <button onClick={onSuggest}>采购建议</button>}</article>
        })}</div>
    </section>;
}

function AdminOrders({
                          orders,
                          onCreate,
                          onRefresh,
                          onEdit,
                         onDelete,
                         onBatchShip,
                         onBatchSettle,
                         onOpen,
                         onApprove,
                         onReceive,
                         onReject,
                         onShip,
                         onSettle,
                         onNotify
                      }: { orders: PurchaseOrder[]; onCreate: () => void; onRefresh: () => Promise<boolean>; onEdit: (id: string) => void; onDelete: (ids: string[]) => Promise<boolean>; onBatchShip: (shipments: Array<{ orderId: string; courier: string; company: string }>) => Promise<boolean>; onBatchSettle: (ids: string[]) => Promise<boolean>; onOpen: (id: string) => void; onApprove: (id: string) => void; onReceive: (id: string) => void; onReject: (id: string) => void; onShip: (id: string) => void; onSettle: (id: string) => void; onNotify: (text: string) => void }) {
    const [query, setQuery] = useState("");
    const [statuses, setStatuses] = useState<string[]>([]);
    const [platform, setPlatform] = useState("全部渠道");
    const [settlement, setSettlement] = useState("全部结款状态");
    const [buyers, setBuyers] = useState<string[]>([]);
    const [buyerOpen, setBuyerOpen] = useState(false);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [batchShipOpen, setBatchShipOpen] = useState(false);
    const [batchSettleOpen, setBatchSettleOpen] = useState(false);
    const [dateDays, setDateDays] = useState(30);
    const [sort, setSort] = useState<OrderSort>(null);
    const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [exporting, setExporting] = useState(false);
    const {now, timeZone} = useServerClock();
    const {start: dateStart, end: dateEnd} = dayRange(now, timeZone, dateDays);
    const readyCount = orders.filter(order => readyToShip(order.status)).length;
    const purchasers = useMemo(() => Array.from(new Set(orders.map(order => order.purchaser))).sort((a, b) => a.localeCompare(b, "zh-CN")), [orders]);
    const buyerSummary = buyers.length === 0 ? "全部采购员" : buyers.length <= 2 ? buyers.join("、") : `${buyers[0]} 等 ${buyers.length} 人`;
    const toggleBuyer = (name: string) => setBuyers(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name]);
    const cycleSort = (key: OrderSortKey) => setSort(current => current?.key !== key ? {key, direction: "desc"} : current.direction === "desc" ? {key, direction: "asc"} : null);
    const activeFilterCount = Number(Boolean(query.trim())) + Number(statuses.length > 0) + Number(platform !== "全部渠道") +
        Number(buyers.length > 0) + Number(dateDays !== 30) + Number(settlement !== "全部结款状态") + Number(sort !== null);
    const advancedFilterCount = Number(dateDays !== 30) + Number(settlement !== "全部结款状态") + Number(sort !== null);
    const advancedFilterSummary = `${dateDays === 1 ? "今天" : `近${dateDays}天`} · ${settlement} · ${sort ? `${orderSortOptions.find(option => option.key === sort.key)?.label}${sort.direction === "desc" ? "倒序" : "顺序"}` : "默认排序"}`;
    const clearAllFilters = () => {
        setQuery("");
        setStatuses([]);
        setPlatform("全部渠道");
        setBuyers([]);
        setBuyerOpen(false);
        setDateDays(30);
        setSettlement("全部结款状态");
        setSort(null);
    };
    const visible = useMemo(() => sortPurchaseOrders(orders.filter(order => dateKey(order.createdAt, timeZone) >= dateStart && dateKey(order.createdAt, timeZone) <= dateEnd && matchesStatusFilter(order, statuses) && (platform === "全部渠道" || order.platform === platform) && (settlement === "全部结款状态" || order.settled === (settlement === "已结款")) && (buyers.length === 0 || buyers.includes(order.purchaser)) && `${order.id}${order.platformNo}${order.items.map(item => `${item.title}${item.sku}${item.purchaseCourierCompany}${item.purchaseCourierNo}${item.outboundCourier ?? ""}`).join("")}`.toLowerCase().includes(query.toLowerCase())), sort), [orders, query, statuses, platform, settlement, buyers, dateStart, dateEnd, timeZone, sort]);
    const selectedSet = new Set(selectedIds), selectedOrders = orders.filter(order => selectedSet.has(order.id)),
        selectedReady = selectedOrders.filter(order => readyToShip(order.status)),
        selectedSettleReady = selectedOrders.filter(order => order.receivedAt && !order.settled),
        selectedItemQuantity = selectedOrders.reduce((sum, order) => sum + order.items.reduce((qty, item) => qty + item.qty, 0), 0),
        allVisibleSelected = visible.length > 0 && visible.every(order => selectedSet.has(order.id));
    const exportOrders = selectedIds.length ? selectedOrders : visible;
    const toggle = (id: string) => setSelectedIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
    const toggleAll = () => setSelectedIds(current => allVisibleSelected ? current.filter(id => !visible.some(order => order.id === id)) : Array.from(new Set([...current, ...visible.map(order => order.id)])));

    async function confirmDelete() {
        if (await onDelete(selectedIds)) {
            setSelectedIds([]);
            setDeleteOpen(false);
        }
    }

    async function confirmBatchShip(shipments: Array<{ orderId: string; courier: string; company: string }>) {
        if (await onBatchShip(shipments)) {
            setSelectedIds(current => current.filter(id => !shipments.some(item => item.orderId === id)));
            setBatchShipOpen(false);
        }
    }

    async function refreshOrders() {
        if (refreshing) return;
        setRefreshing(true);
        try {
            await onRefresh();
        } finally {
            setRefreshing(false);
        }
    }

    async function downloadExcel() {
        if (exporting || !exportOrders.length) return;
        setExporting(true);
        try {
            const response = await fetch("/api/export", {
                method: "POST",
                headers: {"content-type": "application/json"},
                body: JSON.stringify({orderIds: exportOrders.map(order => order.id)})
            });
            if (!response.ok) {
                const detail = await response.json().catch(() => null) as { error?: string } | null;
                throw new Error(detail?.error || "导出失败");
            }
            const blob = await response.blob();
            const disposition = response.headers.get("content-disposition") ?? "";
            const fileName = disposition.match(/filename="([^"]+)"/)?.[1] ?? "junjun-orders.xlsx";
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 0);
            onNotify(`已导出 ${exportOrders.length} 笔订单`);
        } catch (error) {
            onNotify(error instanceof Error ? error.message : "导出失败");
        } finally {
            setExporting(false);
        }
    }

    /** 「导出文案」：把和导出 Excel 相同范围的订单合并成可直接粘贴的采购清单，优先写剪贴板，剪贴板不可用时下载 txt。 */
    async function copyOrderText() {
        if (!exportOrders.length) return;
        const text = buildOrderCopyText(exportOrders, now, timeZone);
        try {
            await copyText(text);
            onNotify(`已复制 ${exportOrders.length} 笔订单的文案，可直接粘贴`);
        } catch {
            const url = URL.createObjectURL(new Blob([text], {type: "text/plain;charset=utf-8"}));
            const link = document.createElement("a");
            link.href = url;
            link.download = `junjun-orders-${dateKey(now, timeZone)}.txt`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 0);
            onNotify("剪贴板不可用，已改为下载文案文件");
        }
    }

    async function confirmBatchSettle() {
        const ids = selectedSettleReady.map(order => order.id);
        if (await onBatchSettle(ids)) {
            setSelectedIds(current => current.filter(id => !ids.includes(id)));
            setBatchSettleOpen(false);
        }
    }

    return <section className="enter">
        <button className="admin-order-create" onClick={onCreate}>
            <span><b>＋ 新增采购订单</b><small>管理员代录订单，保存后进入统一审核流程</small></span><em>去创建 ›</em></button>
        <Search value={query} onChange={setQuery} placeholder="搜索单号 / 快递单号 / 货号" historyKey="admin-orders"/>
        {readyCount > 0 && <button className="shipping-guide" onClick={() => {
            setStatuses(["待发货"]);
            setPlatform("全部渠道");
            setBuyers([]);
            setSettlement("全部结款状态");
        }}><i>🚚</i><span><b>{readyCount} 笔订单等待更新发货信息</b><small>可单笔更新，或勾选多笔订单批量填写发货物流</small></span><em>查看 ›</em>
        </button>}
        <StatusFilter options={["全部", "待审核", "在途", "待发货", "已发货", "已驳回"]} value={statuses} onChange={setStatuses}/>
        <div className="select-row order-filter-row order-primary-filter-row"><select aria-label="采购渠道" value={platform} onChange={e => setPlatform(e.target.value)}>
            <option>全部渠道</option>
            {purchaseChannels.map(channel => <option key={channel}>{channel}</option>)}</select>
            <button type="button"
                    className={`buyer-filter-trigger ${buyers.length ? "active" : ""} ${buyerOpen ? "open" : ""}`}
                    aria-expanded={buyerOpen} aria-haspopup="true" onClick={() => setBuyerOpen(value => !value)}>
                <span>{buyerSummary}</span>{buyers.length > 0 && <b>{buyers.length}</b>}<i>▾</i></button></div>
        {buyerOpen && <div className="buyer-filter-panel" role="group" aria-label="按采购员筛选">
            <div className="buyer-filter-head">
                <b>选择采购员</b><span>可多选 · {buyers.length ? `已选 ${buyers.length} 位` : "未选择时显示全部"}</span>{buyers.length > 0 &&
                <button type="button" className="buyer-filter-clear" onClick={() => setBuyers([])}>清空</button>}</div>
            <div className="buyer-filter-options">{purchasers.map(name => {
                const checked = buyers.includes(name);
                const count = orders.filter(order => order.purchaser === name).length;
                return <button key={name} type="button" className={checked ? "checked" : ""} aria-pressed={checked}
                               onClick={() => toggleBuyer(name)}>
                    <i>{checked ? "✓" : ""}</i><span>{name}</span><small>{count} 笔</small></button>;
            })}</div>
            <button type="button" className="buyer-filter-done" onClick={() => setBuyerOpen(false)}>完成</button>
        </div>}
        <button type="button" className={`order-more-filters-toggle ${advancedFilterCount ? "active" : ""}`}
                aria-expanded={moreFiltersOpen} aria-controls="admin-order-advanced-filters"
                onClick={() => setMoreFiltersOpen(open => !open)}>
            <span className="order-more-filters-icon" aria-hidden="true">⚙</span>
            <span className="order-more-filters-copy"><b>更多筛选{advancedFilterCount > 0 && <em>{advancedFilterCount}</em>}</b><small>{advancedFilterSummary}</small></span>
            <span className="order-more-filters-chevron" aria-hidden="true">{moreFiltersOpen ? "收起⌃" : "展开⌄"}</span>
        </button>
        <div id="admin-order-advanced-filters" className="order-advanced-panel" hidden={!moreFiltersOpen}>
            <div className="select-row order-advanced-row">
                <select aria-label="日期" value={dateDays} onChange={e => setDateDays(Number(e.target.value))}>
                    <option value={30}>近30天</option>
                    <option value={7}>近7天</option>
                    <option value={1}>今天</option>
                    <option value={90}>近90天</option>
                </select>
                <select aria-label="结款状态" value={settlement} onChange={e => setSettlement(e.target.value)}>
                    <option>全部结款状态</option>
                    <option>已结款</option>
                    <option>未结款</option>
                </select>
            </div>
            <div className="order-sort-controls" role="group" aria-label="订单时间排序">
                <div className="order-sort-copy"><b>排序方式</b><span>点击按钮依次切换倒序、顺序和默认</span></div>
                <div className="order-sort-buttons">{orderSortOptions.map(option => {
                    const direction = sort?.key === option.key ? sort.direction : null;
                    const active = direction !== null;
                    const stateLabel = direction === "asc" ? "顺序" : direction === "desc" ? "倒序" : "默认";
                    return <button type="button" key={option.key}
                                   className={`order-sort-button ${active ? `active ${direction}` : ""}`}
                                   aria-pressed={active} aria-label={`${option.label}：${stateLabel}`}
                                   onClick={() => cycleSort(option.key)}>
                        <i>{direction === "asc" ? "↑" : direction === "desc" ? "↓" : "↕"}</i>
                        <span><b>{option.label}</b><small>{stateLabel}</small></span>
                    </button>;
                })}</div>
            </div>
        </div>
        <div className={`order-filter-actions ${activeFilterCount ? "active" : ""}`}>
            <span>{activeFilterCount ? `当前已应用 ${activeFilterCount} 项筛选或排序` : "当前使用默认筛选条件"}</span>
            <div className="order-filter-buttons">
                <button type="button" disabled={!activeFilterCount} onClick={clearAllFilters}>
                    <i aria-hidden="true">↺</i> 清除全部筛选
                </button>
                <button type="button" className={`order-refresh-button ${refreshing ? "busy" : ""}`}
                        disabled={refreshing} aria-busy={refreshing} onClick={() => void refreshOrders()}>
                    <i aria-hidden="true">⟳</i> {refreshing ? "正在刷新" : "刷新订单数据"}
                </button>
            </div>
        </div>
        <SectionHead title="采购订单" note={orderListSummary(visible)}/>
        <div className="batch-toolbar"><label><input type="checkbox" checked={allVisibleSelected} onChange={toggleAll}/><span>{allVisibleSelected ? "取消全选" : "全选当前结果"}</span></label><b>{selectedIds.length ? `已选择 ${selectedIds.length} 笔 · 共 ${selectedItemQuantity} 件` : "可批量选择订单"}</b>
            <button className="batch-settle-button" disabled={!selectedSettleReady.length}
                    onClick={() => setBatchSettleOpen(true)}>批量结款{selectedSettleReady.length ? ` ${selectedSettleReady.length}` : ""}</button>
            <button className="batch-ship-button" disabled={!selectedReady.length}
                    onClick={() => setBatchShipOpen(true)}>批量发货{selectedReady.length ? ` ${selectedReady.length}` : ""}</button>
            <button className="batch-delete-button" disabled={!selectedIds.length}
                    onClick={() => setDeleteOpen(true)}>批量删除
            </button>
            <button type="button" className="batch-export-button" disabled={exporting || !exportOrders.length}
                    aria-busy={exporting} onClick={() => void downloadExcel()}>{exporting ? "正在导出…" : selectedIds.length ? `导出已选 ${selectedIds.length}` : `导出当前 ${visible.length}`}</button>
            <button type="button" className="batch-copy-button" disabled={!exportOrders.length}
                    title="按货号、商品名、尺码合并件数，复制成可粘贴的采购清单"
                    onClick={() => void copyOrderText()}>导出文案</button>
        </div>
        <div className="order-list">{visible.map(order => <OrderCard key={order.id} order={order} selectable
                                                                     selected={selectedSet.has(order.id)}
                                                                     onSelect={() => toggle(order.id)}
                                                                     onOpen={() => onOpen(order.id)}
                                                                     showPurchaserContact showLocation actions={<>
            <button className="edit-ghost" onClick={() => onEdit(order.id)}>编辑</button>
            {order.receivedAt && !order.settled && <button className="settlement-action"
                                                           onClick={() => onSettle(order.id)}>确认结款</button>}
            {canRejectOrder(order) && <button className="danger-ghost"
                                              onClick={() => onReject(order.id)}>驳回</button>}{order.status === "待审核" ? <>
            <button className="small-primary" onClick={() => onApprove(order.id)}>✓ 通过</button>
        </> : order.status === "在途" ? <button className="small-primary receive-action"
                                              onClick={() => onReceive(order.id)}>手动入库</button> : readyToShip(order.status) ?
            <button className="small-primary purple-action" onClick={() => onShip(order.id)}>🚚
                去发货</button> : order.status === "已发货" ? <button className="small-primary shipping-edit-action"
                                                                onClick={() => onShip(order.id)}>编辑发货信息</button> : null}</>}/>)}</div>
        {deleteOpen && <DeleteOrdersSheet count={selectedIds.length} onClose={() => setDeleteOpen(false)}
                                          onSubmit={confirmDelete}/>} {batchSettleOpen &&
        <BatchSettlementSheet orders={selectedSettleReady} onClose={() => setBatchSettleOpen(false)} onSubmit={confirmBatchSettle}/>} {batchShipOpen &&
        <BatchShipSheet orders={selectedReady} onClose={() => setBatchShipOpen(false)} onSubmit={confirmBatchShip}/>}
    </section>;
}

function OrderCard({
                       order,
                       onOpen,
                       actions,
                       selectable = false,
                       selected = false,
                       onSelect,
                       showOutbound = true,
                       normalizeStatus = true,
                       showPurchaserContact = false,
                       showLocation = false
                   }: { order: PurchaseOrder; onOpen: () => void; actions?: React.ReactNode; selectable?: boolean; selected?: boolean; onSelect?: () => void; showOutbound?: boolean; normalizeStatus?: boolean; showPurchaserContact?: boolean; showLocation?: boolean }) {
    const {dateTime} = useServerClock();
    const listTitle = orderTitleWithQuantity(order);
    return <article className={`order-card edge-${statusTone[order.status]} ${selected ? "selected" : ""}`}>
        {selectable &&
            <label className="order-select"><input type="checkbox" aria-label={`选择订单 ${order.id}`} checked={selected}
                                                   onChange={onSelect}/><span>选择</span></label>}
        <div className="order-main" role="button" tabIndex={0} onClick={onOpen} onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen();
            }
        }}>
            <div className="order-top"><h4 title={listTitle}>{listTitle}</h4><Badge
                tone={statusTone[order.status]}>{normalizeStatus ? statusLabel(order.status) : order.status}</Badge>
            </div>
            <div className="order-meta"><span>{order.platform} · 采购人：{order.purchaser}</span><b>{money(order.amount)}</b>
            </div>
            <div className="order-meta secondary">{order.platformNo ?
                <CopyNumber value={order.platformNo} label="平台订单号"/> : <span>平台单号未填写</span>}
                <time>{dateTime(order.createdAt)}</time>
            </div>
            {showPurchaserContact && <div className="order-contact"><span>采购员联系方式</span>
                <div>{order.purchaserWechatId &&
                    <div className="contact-value"><em>微信</em><CopyNumber value={order.purchaserWechatId}
                                                                          label="采购员微信号"/>
                    </div>}{order.purchaserPhone &&
                    <div className="contact-value"><em>手机</em><CopyNumber value={order.purchaserPhone} label="采购员手机号"/>
                    </div>}</div>
            </div>}
            <div className="order-purchase-logistics"><span>采购快递信息</span><PurchaseCourierList items={order.items}
                                                                                              showItem={order.items.length > 1}/>
            </div>
            <SettlementStatus order={order}/>
            {showOutbound && (readyToShip(order.status) || order.status === "已发货") &&
                <OutboundOrderInfo order={order}/>}
            {showLocation && readyToShip(order.status) && <div className="order-courier order-location">
                <span>库位</span><b>{order.location || "未填写"}</b>
            </div>}
            {order.rejectReason && <p className="reject-note">原因：{order.rejectReason}</p>}
        </div>
        {actions && <div className="order-actions">{actions}</div>}
    </article>;
}

function SettlementStatus({order}: { order: PurchaseOrder }) {
    const {dateTime} = useServerClock();
    return <div className={`order-settlement ${order.settled ? "settled" : "pending"}`}>
        <span>采购结款</span><b>{order.settled ? <><em>已结款{order.settledAmount != null ? ` · ${money(order.settledAmount)}` : " · 金额未记录"}</em><time>{dateTime(order.settledAt)}</time></> :
        <em>{order.receivedAt ? "待结款" : "入库后可结款"}</em>}</b>
    </div>;
}

function OutboundOrderInfo({order}: { order: PurchaseOrder }) {
    const {dateTime} = useServerClock();
    const shippedItems = order.items.filter(item => item.shipped);
    if (order.status !== "已发货") return <div className={`order-courier outbound ${shippedItems.length ? "" : "empty"}`}>
        <span>发货进度</span><b><span>{shippedItems.reduce((sum, item) => sum + item.qty, 0)}/{order.items.reduce((sum, item) => sum + item.qty, 0)} 件已发货</span></b>
    </div>;
    return <div className="order-shipment-summary">
        <div className="order-shipment-head">
            <span>发货信息</span><b>{shippedItems.reduce((sum, item) => sum + item.qty, 0)} 件已发货</b></div>
        {shippedItems.map(item => <div className="order-shipment-row" key={item.id}>
            <div className="order-shipment-product">
                <b>{item.title}</b><span>{item.sku} · {item.size}码 · ×{item.qty}</span></div>
            <div className="order-shipment-detail"><span>发货运单</span><b>{item.outboundCompany ?
                <em>{item.outboundCompany}</em> : null}{item.outboundCourier ?
                <CopyNumber value={item.outboundCourier} label="发货运单号"/> : "未填写"}</b></div>
            <div className="order-shipment-detail"><span>发货时间</span>
                <time>{dateTime(item.shippedAt)}</time>
            </div>
        </div>)}</div>;
}

function BuyerOrderCard({order, onOpen, onEdit}: { order: PurchaseOrder; onOpen: () => void; onEdit?: () => void }) {
    return <OrderCard order={order} onOpen={onOpen} showOutbound={false} normalizeStatus={false}
                      actions={onEdit && buyerCanEditOrder(order.status) ?
                          <button className="edit-ghost buyer-edit-order"
                                  onClick={onEdit}>{order.status === "已驳回" ? "修改后重新提交" : "编辑采购单"}</button> : undefined}/>;
}

function UploadTutorialLink() {
    return <a className="tutorial-banner" href="/tutorial/upload-order.html" target="_blank" rel="noreferrer">
        <i>教程</i><span><b>上传订单教程</b><small>分步图解，含识图填写与常见报错</small></span><em>打开</em>
    </a>;
}

function BuyerHome({
                       buyerName,
                       orders,
                       onUpload,
                       onMine,
                       onEdit
                   }: { buyerName: string; orders: PurchaseOrder[]; onUpload: () => void; onMine: () => void; onEdit: (id: string) => void }) {
    const {now, timeZone} = useServerClock();
    const month = dateKey(now, timeZone).slice(0, 7);
    const monthCount = orders.filter(order => dateKey(order.createdAt, timeZone).slice(0, 7) === month && timestamp(order.createdAt) <= now).length;
    const rejected = orders.find(o => o.status === "已驳回");
    const count = (status: OrderStatus) => orders.filter(o => o.status === status).length;
    return <section className="enter buyer-home">
        <div className="buyer-welcome"><span>采购员 · {buyerName}</span><h2>今天也要买到好价 👋</h2><p>订单及时上报，仓库收货更高效</p></div>
        <UploadTutorialLink/>
        <div className="buyer-stats">
            <button onClick={onMine}><b>{count("待审核")}</b><span>待审核</span></button>
            <button onClick={onMine}><b>{count("在途")}</b><span>在途</span></button>
            <button onClick={onMine}><b>{count("已入库")}</b><span>已入库</span></button>
            <button onClick={onMine}><b>{monthCount}</b><span>本月单数</span></button>
        </div>
        {rejected && <div className="rejected-alert">
            <div><span>!</span><b>有订单被驳回</b></div>
            <h4>{rejected.title}{rejected.itemCount > 1 ? ` 等${rejected.itemCount}件` : ""}</h4>
            <p>{rejected.rejectReason}</p>
            <button onClick={() => onEdit(rejected.id)}>修改后重新提交</button>
        </div>}
        <SectionHead title="快捷操作" note="10 秒完成上报"/>
        <div className="buyer-quick">
            <button className="upload-quick" onClick={onUpload}>
                <i>＋</i><span><b>上传采购订单</b><small>填写渠道、商品与物流信息</small></span><em>›</em></button>
            <button onClick={onMine}><i>▤</i><span><b>查看我的订单</b><small>跟踪审核、在途与入库状态</small></span><em>›</em></button>
        </div>
        <SectionHead title="最近订单" note="查看全部"/>
        <div className="order-list compact">{orders.slice(0, 2).map(order => <BuyerOrderCard key={order.id}
                                                                                             order={order}
                                                                                             onOpen={onMine}/>)}</div>
    </section>;
}

function UploadPage({
                        mode,
                        editing,
                        people = [],
                        onCancel,
                        onSubmit
                    }: { mode: "admin" | "buyer"; editing?: PurchaseOrder; people?: AppUser[]; onCancel?: () => void; onSubmit: (order: PurchaseOrder, files: File[]) => Promise<void> }) {
    const [purchaserId, setPurchaserId] = useState(editing?.purchaserId ?? "");
    const purchaserOptions = people.filter(person => person.id === editing?.purchaserId || (person.active && person.approvalStatus === "approved"));
    const [platform, setPlatform] = useState(editing?.platform ?? "京东"), [platformNo, setPlatformNo] = useState(editing?.platformNo ?? ""), [files, setFiles] = useState<File[]>([]), [submitting, setSubmitting] = useState(false);
    const [items, setItems] = useState<OrderItemDraft[]>(() => editing ? editing.items.map(item => {
        const company = item.purchaseCourierCompany || editing.courierCompany || "";
        const choice = courierCompanyChoice(company);
        return {
            id: item.id,
            title: item.title,
            sku: item.sku,
            size: item.size,
            qty: item.qty,
            amount: item.amount.toString(),
            purchaseCourierCompany: choice,
            customPurchaseCourierCompany: choice === "其他" ? company : "",
            purchaseCourierNo: item.purchaseCourierNo || editing.courierNo || ""
        };
    }) : [emptyOrderItemDraft()]);
    const updateItem = (index: number, patch: Partial<OrderItemDraft>) => setItems(current => current.map((item, i) => i === index ? {...item, ...patch} : item));
    const [recognizing, setRecognizing] = useState(false), [recognition, setRecognition] = useState<{ filled: string[]; missing: string[]; notes: string[]; error?: string } | null>(null);

    async function recognize(incoming?: FileList | null) {
        const selected = Array.from(incoming ?? []).filter(file => file.type.startsWith("image/")).slice(0, 3);
        if (!selected.length || recognizing) return;
        setRecognizing(true);
        setRecognition(null);
        try {
            const form = new FormData();
            selected.forEach(file => form.append("images", file));
            const response = await fetch("/api/orders/recognize", {method: "POST", body: form});
            const json = await response.json() as { data?: RecognizedOrder; error?: string };
            if (!response.ok || !json.data) throw new Error(json.error || "识别失败，请重试");
            const data = json.data, filled: string[] = [], missing: string[] = [];
            if (data.platform && purchaseChannels.some(channel => channel === data.platform)) {
                setPlatform(data.platform);
                filled.push("采购渠道");
            } else missing.push("采购渠道");
            if (data.platformNo) {
                setPlatformNo(data.platformNo);
                filled.push("平台订单号");
            } else missing.push("平台订单号");
            if (data.courierCompany) filled.push("快递公司"); else missing.push("快递公司");
            if (data.courierNo) filled.push("快递单号"); else missing.push("快递单号");
            if (data.items.length) {
                const drafts = data.items.map((item, index) => {
                    const match = data.knowledgeMatches?.[index];
                    const filledItem = fillProductIdentity(item, match);
                    return applyRecognizedCourier({
                    id: "",
                    title: filledItem.title,
                    sku: filledItem.sku,
                    size: item.size,
                    qty: item.qty,
                    amount: item.amount != null && item.amount > 0 ? String(item.amount) : "",
                    purchaseCourierCompany: "顺丰速运",
                    customPurchaseCourierCompany: "",
                    purchaseCourierNo: "",
                    knowledgeHint: match?.kind !== "none" ? match : undefined
                }, data.courierCompany, data.courierNo);
                });
                setItems(current => {
                    const blank = current.every(item => !item.title.trim() && !item.sku.trim() && !item.size.trim() && !item.amount.trim());
                    if (!blank) return [...current, ...drafts];
                    return drafts.map((draft, index) => {
                        const previous = current[index] ?? current[0];
                        return previous && !draft.purchaseCourierNo.trim() && previous.purchaseCourierNo.trim() ? applyRecognizedCourier(draft, previous.purchaseCourierCompany === "其他" ? previous.customPurchaseCourierCompany : previous.purchaseCourierCompany, previous.purchaseCourierNo) : draft;
                    });
                });
                filled.push(`${data.items.length} 个商品`);
                const autoCount=data.knowledgeMatches?.filter(match=>match.kind==="auto").length ?? 0;
                if(autoCount)filled.push(`知识库补全 ${autoCount} 款`);
            } else {
                if (data.courierCompany || data.courierNo) setItems(current => current.map(item => applyRecognizedCourier(item, data.courierCompany, data.courierNo)));
                missing.push("商品信息");
            }
            setFiles(current => {
                const next = [...current];
                for (const file of selected) {
                    if (next.length >= 3) break;
                    if (next.some(existing => existing.name === file.name && existing.size === file.size)) continue;
                    next.push(file);
                }
                return next;
            });
            setRecognition({filled, missing, notes: data.notes});
        } catch (error) {
            setRecognition({
                filled: [],
                missing: [],
                notes: [],
                error: error instanceof Error ? error.message : "识别失败，请重试"
            });
        } finally {
            setRecognizing(false);
        }
    }

    const itemsValid = items.every(item => item.title.trim() && item.sku.trim() && item.size.trim() && Number.isInteger(Number(item.qty)) && Number(item.qty) > 0 && Number(item.amount) > 0 && resolvedPurchaseCourierCompany(item) && item.purchaseCourierNo.trim());

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!itemsValid) return;
        const normalizedItems = items.map(item => ({
            id: item.id,
            title: item.title.trim(),
            sku: item.sku.trim(),
            size: item.size.trim(),
            qty: Number(item.qty),
            amount: Number(item.amount),
            purchaseCourierCompany: resolvedPurchaseCourierCompany(item),
            purchaseCourierNo: item.purchaseCourierNo.trim()
        }));
        setSubmitting(true);
        try {
            await onSubmit({
                id: editing?.id ?? "",
                platform,
                platformNo,
                courierCompany: normalizedItems[0].purchaseCourierCompany,
                courierNo: normalizedItems[0].purchaseCourierNo,
                status: "待审核",
                purchaser: "",
                ...(mode === "admin" && editing ? {purchaserId} : {}),
                settled: editing?.settled ?? false,
                settledAt: editing?.settledAt,
                settledAmount: editing?.settledAmount,
                createdAt: "",
                title: normalizedItems[0].title,
                itemCount: normalizedItems.length,
                amount: normalizedItems.reduce((sum, item) => sum + item.amount, 0),
                items: normalizedItems,
                images: editing?.images ?? [],
                settlementProofs: editing?.settlementProofs ?? []
            }, files);
        } finally {
            setSubmitting(false);
        }
    }

    return <section className="enter upload-page">
        <div className="form-intro">
            <div>
                <span>{editing ? (mode === "admin" ? "ADMIN EDIT" : editing.status === "已驳回" ? "驳回订单修改" : "PURCHASE EDIT") : mode === "admin" ? "ADMIN PURCHASE" : "NEW PURCHASE"}</span>
                <h2>{editing ? (mode === "admin" ? "编辑采购订单" : editing.status === "已驳回" ? "修改并重新提交" : "编辑采购订单") : mode === "admin" ? "新增采购订单" : "上报采购订单"}</h2>
                <p>{mode === "admin" ? "以管理员身份录入，订单与附件将持久化保存到服务器。" : editing && editing.status !== "已驳回" ? `订单当前为“${editing.status}”，入库前均可修改并保存。` : "订单与附件将持久化保存到服务器，提交后可跨设备查看。"}</p>
            </div>
            {onCancel && <button className="form-back-button" type="button" onClick={onCancel}>返回订单</button>}</div>
        <UploadTutorialLink/>
        {editing?.rejectReason && <div className="inline-warning"><b>驳回原因</b><span>{editing.rejectReason}</span></div>}
        <form className="purchase-form" autoComplete="off" onSubmit={submit}>
            {mode === "admin" && editing && <label><span>采购人 *</span>
                <select value={purchaserId} required onChange={event => setPurchaserId(event.target.value)}>
                    {!purchaserOptions.some(person => person.id === purchaserId) && <option value={purchaserId}>{editing.purchaser}（当前采购人）</option>}
                    {purchaserOptions.map(person => <option key={person.id} value={person.id}>
                        {person.name} · {person.wechatId}{person.id === editing.purchaserId ? "（当前）" : ""}
                    </option>)}
                </select>
            </label>}
            <label className={`recognize-zone ${recognizing ? "busy" : ""}`}><input type="file" accept="image/*" multiple
                                                                                    disabled={recognizing}
                                                                                    onChange={e => {
                                                                                        void recognize(e.target.files);
                                                                                        e.target.value = "";
                                                                                    }}/><i>{recognizing ? "…" : "✦"}</i><span><b>{recognizing ? "正在识别订单截图，请稍候" : "智能识图：上传订单截图自动填写"}</b><small>最多 3 张，支持京东 / 拼多多 / 淘宝 / 唯品会 / 抖音；同一订单可分段截图</small><em>此为辅助功能，识图后需核对！</em></span></label>
            {recognition && (recognition.error ?
                <div className="recognize-result failed"><b>识别失败</b><span>{recognition.error}</span></div> :
                <div className="recognize-result">
                    <b>已自动填写：{recognition.filled.join("、") || "无"}</b>{recognition.missing.length > 0 &&
                    <span>未识别到：{recognition.missing.join("、")}，请手动补充</span>}{recognition.notes.map(note => <small
                    key={note}>{note}</small>)}<em>截图已加入订单附件</em></div>)}
            <div className="field-grid"><label><span>采购渠道 *</span><select value={platform}
                                                                          onChange={e => setPlatform(e.target.value)}>{purchaseChannels.map(channel =>
                <option key={channel}>{channel}</option>)}</select></label><label><span>平台订单号（选填）</span><input
                className="long-no-input" value={platformNo} onChange={e => setPlatformNo(e.target.value)} placeholder="请输入订单号"/></label></div>
            <div className="items-editor">
                <div className="items-editor-head"><b>商品明细</b><span>{items.length} 件商品</span></div>
                {items.map((item, index) => <div className="item-card" key={index}>
                    <div className="item-card-head">
                        <i>{index + 1}</i><b>{item.title.trim() || `商品 ${index + 1}`}</b>{items.length > 1 &&
                        <button className="item-remove" type="button" aria-label={`删除商品 ${index + 1}`}
                                onClick={() => setItems(current => current.filter((_, i) => i !== index))}>删除</button>}
                    </div>
                    {item.knowledgeHint?.kind === "auto" && <div className="knowledge-hint auto" role="status">
                        <b>已按商品知识库补全</b><span>请核对商品名称与货号；金额、尺码和数量仍以本次截图为准。</span>
                    </div>}
                    {item.knowledgeHint?.kind === "suggestion" && <div className="knowledge-hint suggestion">
                        <b>找到相似商品，请核对后选择</b>
                        <div>{item.knowledgeHint.candidates.map(candidate => <button key={candidate.id} type="button"
                            onClick={() => updateItem(index, {title:candidate.title,sku:candidate.sku,knowledgeHint:undefined})}>
                            {candidate.title} · {candidate.sku} <strong>采用</strong>
                        </button>)}</div>
                        <small>不选择则保留识图结果；货号仍按规格描述或商品名称兜底。</small>
                    </div>}
                    <label><span>商品名称 *</span><input value={item.title}
                                                     onChange={e => updateItem(index, {title: e.target.value,knowledgeHint:undefined})}
                                                     placeholder="如 乔丹 DUNK LOW 熊猫"/></label>
                    <div className="field-grid"><label><span>货号 *</span><input value={item.sku}
                                                                               onChange={e => updateItem(index, {sku: e.target.value,knowledgeHint:undefined})}
                                                                               placeholder="DD1391-100"/></label><label><span>尺码 *</span><input
                        value={item.size} onChange={e => updateItem(index, {size: e.target.value})}
                        placeholder="42 / 41.5"/></label></div>
                    <div className="field-grid"><label><span>数量 *</span><input type="number" inputMode="numeric" min="1"
                                                                               step="1" value={item.qty}
                                                                               onChange={e => {
                                                                                   const value = e.target.value;
                                                                                   updateItem(index, {qty: value === "" ? "" : Math.max(1, Math.trunc(Number(value)))})
                                                                               }} onBlur={() => {
                        if (item.qty === "") updateItem(index, {qty: 1})
                    }}/></label><label><span>实付金额 *</span>
                        <div className="money-input"><i>¥</i><input inputMode="decimal" value={item.amount}
                                                                    onChange={e => updateItem(index, {amount: e.target.value})}
                                                                    placeholder="0.00"/></div>
                    </label></div>
                    <div className="item-purchase-logistics">
                        <div className="item-purchase-logistics-head"><i>🚚</i><b>该商品采购物流</b><span>每件商品可分别填写</span>
                        </div>
                        <div className="field-grid"><label><span>采购快递公司 *</span><select
                            value={item.purchaseCourierCompany} onChange={e => updateItem(index, {
                            purchaseCourierCompany: e.target.value,
                            customPurchaseCourierCompany: e.target.value === "其他" ? "" : item.customPurchaseCourierCompany
                        })}>{courierCompanies.map(company => <option key={company}>{company}</option>)}
                            <option>其他</option>
                        </select></label><label><span>采购快递单号 *</span><input className="long-no-input" value={item.purchaseCourierNo}
                                                                            onChange={e => updateItem(index, {purchaseCourierNo: e.target.value})}
                                                                            placeholder="请输入该商品快递单号"/></label></div>
                        {item.purchaseCourierCompany === "其他" &&
                            <label><span>其他快递公司 *</span><input value={item.customPurchaseCourierCompany}
                                                               onChange={e => updateItem(index, {customPurchaseCourierCompany: e.target.value})}
                                                               placeholder="请输入快递公司名称"/></label>}</div>
                </div>)}
                <button type="button" className="item-add-button"
                        onClick={() => setItems(current => [...current, emptyOrderItemDraft()])}>
                    <i>＋</i><span><b>添加商品</b><small>每个商品可设置不同的采购快递公司与单号</small></span></button>
                <div className="items-total">
                    <span>合计 {items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)} 件</span><b>{money(items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0))}</b>
                </div>
            </div>
            <label className="upload-zone"><input type="file" accept="image/*" multiple
                                                  onChange={e => setFiles(Array.from(e.target.files ?? []).slice(0, 3))}/><i>＋</i><b>{files.length ? `已选择 ${files.length} 张截图` : "上传订单截图"}</b><span>持久化保存，最多 3 张、单张不超过 5MB</span></label>
            <button className="primary-button" disabled={submitting || !itemsValid}
                    type="submit">{submitting ? "正在保存…" : editing ? (mode === "admin" ? "保存订单修改" : editing.status === "已驳回" ? "重新提交审核" : "保存修改") : mode === "admin" ? "创建采购订单" : "提交订单"}</button>
            <p className="form-footnote">平台订单号选填；每个商品需分别填写采购快递公司与快递单号</p></form>
    </section>;
}

function BuyerOrders({
                         orders,
                         onOpen,
                         onEdit
                     }: { orders: PurchaseOrder[]; onOpen: (id: string) => void; onEdit: (id: string) => void }) {
    const [statuses, setStatuses] = useState<string[]>([]);
    const [query, setQuery] = useState("");
    const [platform, setPlatform] = useState("全部渠道");
    const [settlement, setSettlement] = useState("全部结款状态");
    const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
    const visible = orders.filter(o => matchesStatusFilter(o, statuses) && (platform === "全部渠道" || o.platform === platform) && (settlement === "全部结款状态" || o.settled === (settlement === "已结款")) && `${o.title}${o.items.map(item => `${item.sku}${item.purchaseCourierCompany}${item.purchaseCourierNo}`).join("")}${o.platformNo}`.toLowerCase().includes(query.toLowerCase()));
    return <section className="enter"><Search value={query} onChange={setQuery} placeholder="搜索商品 / 订单号 / 快递单号"
                                              historyKey="buyer-orders"/><StatusFilter
        options={["全部", "待审核", "在途", "已入库", "已驳回"]} value={statuses} onChange={setStatuses}/>
        <div className="chip-row scroll">{["全部渠道", ...purchaseChannels].map(v => <button key={v}
                                                                                         className={platform === v ? "active" : ""}
                                                                                         onClick={() => setPlatform(v)}>{v}</button>)}</div>
        <button type="button" className={`order-more-filters-toggle ${settlement !== "全部结款状态" ? "active" : ""}`}
                aria-expanded={moreFiltersOpen} aria-controls="buyer-order-advanced-filters"
                onClick={() => setMoreFiltersOpen(open => !open)}>
            <span className="order-more-filters-icon" aria-hidden="true">⚙</span>
            <span className="order-more-filters-copy"><b>更多筛选{settlement !== "全部结款状态" && <em>1</em>}</b><small>{settlement}</small></span>
            <span className="order-more-filters-chevron" aria-hidden="true">{moreFiltersOpen ? "收起⌃" : "展开⌄"}</span>
        </button>
        <div id="buyer-order-advanced-filters" className="order-advanced-panel" hidden={!moreFiltersOpen}><label className="buyer-settlement-filter"><span>结款状态</span>
            <select aria-label="结款状态" value={settlement} onChange={event => setSettlement(event.target.value)}>
                <option>全部结款状态</option><option>已结款</option><option>未结款</option>
            </select></label></div>
        <SectionHead title="我的采购订单" note={orderListSummary(visible)}/>
        <div className="order-list">{visible.map(order => <BuyerOrderCard key={order.id} order={order}
                                                                          onOpen={() => onOpen(order.id)}
                                                                          onEdit={() => onEdit(order.id)}/>)}</div>
    </section>;
}

function AdminProfile({
                          user,
                          people,
                          onRole,
                          onActive,
                          onCreate,
                          onReview,
                          onResetPassword,
                          onDeleteUser,
                          onNotify
                      }: { user: AppUser; people: AppUser[]; onRole: (id: string, role: Role) => void; onActive: (id: string, active: boolean) => void; onCreate: (member: Record<string, unknown>) => void; onReview: (id: string, decision: "approve" | "reject") => void; onResetPassword: (id: string, password: string) => Promise<boolean>; onDeleteUser: (id: string) => Promise<boolean>; onNotify: (text: string) => void }) {
    const [showCreate, setShowCreate] = useState(false);
    const [resetTarget, setResetTarget] = useState<AppUser | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<AppUser | null>(null);
    const applications = people.filter(person => person.approvalStatus !== "approved");
    const members = people.filter(person => person.approvalStatus === "approved");
    const pendingCount = applications.filter(person => person.approvalStatus === "pending").length;

    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onCreate({
            name: String(data.get("name") ?? ""),
            phone: String(data.get("phone") ?? ""),
            wechatId: String(data.get("wechatId") ?? ""),
            password: String(data.get("password") ?? ""),
            role: String(data.get("role") ?? "buyer")
        });
        event.currentTarget.reset();
        setShowCreate(false);
    }

    return <section className="enter profile-page">
        <div className="profile-card">
            <div className="avatar">{user.name.slice(0, 1)}</div>
            <div><h2>{user.name}</h2><span>微信号：{user.wechatId}</span></div>
            <Badge tone="purple">管理员</Badge></div>
        <SectionHead title="采购员申请" note={pendingCount ? `${pendingCount} 个待审批` : "暂无待审批"}/>
        {applications.length ? <div className="application-list">{applications.map(person => <article key={person.id}
                                                                                                      className={person.approvalStatus === "rejected" ? "application-rejected" : ""}>
            <div className="application-avatar">{person.name.slice(0, 1)}</div>
            <div className="application-main">
                <div><b>{person.name}</b><Badge
                    tone={person.approvalStatus === "pending" ? "orange" : "red"}>{person.approvalStatus === "pending" ? "待审批" : "未通过"}</Badge>
                </div>
                <span>{person.phone}</span><small>微信号：{person.wechatId}</small></div>
            <div className="application-actions">{person.approvalStatus === "pending" &&
                <button className="application-reject" onClick={() => onReview(person.id, "reject")}>拒绝</button>}
                <button className="application-approve"
                        onClick={() => onReview(person.id, "approve")}>{person.approvalStatus === "pending" ? "通过" : "重新通过"}</button>
            </div>
        </article>)}</div> : <div className="application-empty"><i>✓</i><span>当前没有待处理的采购员申请</span></div>}
        <SectionHead title="成员与权限" note={`${members.length} 人`}/>
        <button className="member-create-button" onClick={() => setShowCreate(value => !value)}>＋ 创建成员账号</button>
        {showCreate && <form className="member-create-form" onSubmit={submit}><input name="name" required
                                                                                     placeholder="成员姓名"/><input
            name="phone" type="tel" required inputMode="numeric" pattern="1[3-9][0-9]{9}" maxLength={11}
            placeholder="11 位手机号"/><input name="wechatId" required minLength={6} maxLength={20}
                                          pattern="[A-Za-z][A-Za-z0-9_-]{5,19}" placeholder="微信号"/><input
            name="password" type="password" required minLength={8} placeholder="初始密码（至少 8 位）"/><select name="role"
                                                                                                       defaultValue="buyer">
            <option value="buyer">采购员</option>
            <option value="admin">管理员</option>
        </select>
            <button className="primary-button" type="submit">创建账号</button>
        </form>}
        <div className="member-list">{members.map(person => <div key={person.id}
                                                                 className={!person.active ? "member-disabled" : ""}>
            <span><b>{person.name}</b><small>{person.wechatId}{person.phone ? ` · ${person.phone}` : ""}</small></span><select
            className="member-role-select"
            value={person.role} disabled={person.id === user.id || !person.active}
            onChange={e => onRole(person.id, e.target.value as Role)}>
            <option value="buyer">采购员</option>
            <option value="admin">管理员</option>
        </select>
            <button className="member-state-button" onClick={() => setResetTarget(person)}>改密</button>
            {person.id !== user.id && <button className="member-state-button"
                                              onClick={() => onActive(person.id, !person.active)}>{person.active ? "停用" : "启用"}</button>}{person.role === "buyer" && person.id !== user.id &&
            <button className="member-delete-button" aria-label={`删除采购员 ${person.name}`}
                    onClick={() => setDeleteTarget(person)}>删除</button>}</div>)}</div>
        <ProductKnowledgePanel/>
        {resetTarget &&
            <ResetPasswordSheet member={resetTarget} onClose={() => setResetTarget(null)} onSubmit={onResetPassword}/>}
        {deleteTarget &&
            <DeleteUserSheet member={deleteTarget} onClose={() => setDeleteTarget(null)} onSubmit={onDeleteUser}/>}
        <SectionHead title="系统能力" note="独立部署"/>
        <div className="profile-menu">
            <button onClick={() => onNotify("利润数据由已发货订单实时计算")}><i>📈</i><span>利润统计</span><small>实时</small><em>›</em>
            </button>
            <a href="/api/export"><i>📤</i><span>导出订单数据</span><small>CSV</small><em>›</em></a>
            <button onClick={() => onNotify("平台适配器需在服务器环境变量中配置凭证")}>
                <i>🔗</i><span>外部平台连接</span><small>服务端配置</small><em>›</em></button>
        </div>
        <a className="logout" href="/api/auth/logout">退出登录</a><p className="version">鸿运采购 v2.0 · 独立服务器版</p>
    </section>;
}

function DeleteUserSheet({
                             member,
                             onClose,
                             onSubmit
                         }: { member: AppUser; onClose: () => void; onSubmit: (id: string) => Promise<boolean> }) {
    const [busy, setBusy] = useState(false);

    async function confirm() {
        if (busy) return;
        setBusy(true);
        try {
            if (await onSubmit(member.id)) onClose();
        } finally {
            setBusy(false);
        }
    }

    return <Modal title="删除采购员" subtitle="DANGER ZONE" onClose={onClose}>
        <div className="modal-product">
            <b>{member.name}</b><span>采购员 · 微信号 {member.wechatId}{member.phone ? ` · ${member.phone}` : ""}{member.active ? "" : " · 已停用"}</span>
        </div>
        <div className="delete-warning"><i>!</i>
            <div><b>确定删除该采购员账号？</b><p>删除后该账号将无法登录，且不可恢复。只有从未提交过订单、没有任何操作记录的账号才能删除；已有历史记录的账号请改用「停用」。</p></div>
        </div>
        <div className="dual-actions">
            <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
            <button className="primary-button danger-button" disabled={busy}
                    onClick={() => void confirm()}>{busy ? "正在删除…" : "确认删除"}</button>
        </div>
    </Modal>;
}

function ResetPasswordSheet({
                                member,
                                onClose,
                                onSubmit
                            }: { member: AppUser; onClose: () => void; onSubmit: (id: string, password: string) => Promise<boolean> }) {
    const [password, setPassword] = useState(""), [confirm, setConfirm] = useState(""), [busy, setBusy] = useState(false);
    const mismatch = confirm.length > 0 && password !== confirm;

    async function submit() {
        if (busy || password.length < 8 || password !== confirm) return;
        setBusy(true);
        try {
            if (await onSubmit(member.id, password)) onClose();
        } finally {
            setBusy(false);
        }
    }

    return <Modal title="重置成员密码" subtitle={member.wechatId} onClose={onClose}>
        <div className="modal-product">
            <b>{member.name}</b><span>{member.role === "admin" ? "管理员" : "采购员"}{member.active ? "" : " · 已停用"}</span>
        </div>
        <label className="modal-field"><span>新密码（至少 8 位）</span><input type="password" value={password}
                                                                      onChange={e => setPassword(e.target.value)}
                                                                      placeholder="请输入新密码" autoComplete="new-password"/></label>
        <label className="modal-field"><span>确认新密码 {mismatch && <em className="field-error">两次输入不一致</em>}</span><input
            type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="再次输入新密码"
            autoComplete="new-password"/></label>
        <button className="primary-button" disabled={password.length < 8 || password !== confirm || busy}
                onClick={() => void submit()}>{busy ? "正在重置…" : "确认重置密码"}</button>
        <p className="form-footnote">重置后立即生效，请线下告知成员新密码</p>
    </Modal>;
}

function LocationPicker({ location, recentLocations, onChange }: { location: string; recentLocations: string[]; onChange: (value: string) => void }) {
    const activeLocation = location.trim();
    return <>
        <label className="location-field"><span>入库库位（必填）</span><input
            value={location} onChange={e => onChange(e.target.value)}
            placeholder="如 A-02-5，或从下方历史库位中选择"/></label>
        {recentLocations.length > 0 && <div className="location-history">
            <div className="location-history-head">
                <i>📍</i><b>历史库位</b><span>{activeLocation && recentLocations.includes(activeLocation) ? `已选 ${activeLocation}` : "点选即可填入，按最近入库排序"}</span>
            </div>
            <div className="location-chips">{recentLocations.map((item, index) => <button key={item} type="button"
                                                                                          className={item === activeLocation ? "active" : ""}
                                                                                          aria-pressed={item === activeLocation}
                                                                                          onClick={() => onChange(item)}>{index === 0 &&
                <em>最近</em>}<span>{item}</span></button>)}</div>
        </div>}
    </>;
}

function ReceiptSheet({
                          orders,
                          recentLocations,
                          onClose,
                          onReceive,
                          onManual,
                          onNotify
                      }: { orders: PurchaseOrder[]; recentLocations: string[]; onClose: () => void; onReceive: (id: string, loc: string) => void; onManual: () => void; onNotify: (t: string) => void }) {
    const {dateTime} = useServerClock();
    const [stage, setStage] = useState<"capture" | "result">("capture"), [courier, setCourier] = useState(""), [location, setLocation] = useState(""), [busy, setBusy] = useState(false);
    const [lookedUp, setLookedUp] = useState<PurchaseOrder[]>([]), [pickedId, setPickedId] = useState("");
    const matches = useMemo(() => {
        const local = findOrdersByCourierNo(orders, courier);
        const extra = findOrdersByCourierNo(lookedUp, courier).filter(order => !local.some(item => item.id === order.id));
        return [...local, ...extra];
    }, [orders, lookedUp, courier]);
    const receivable = matches.filter(order => order.status === "在途");
    const match = receivable.find(order => order.id === pickedId) ?? (receivable.length === 1 ? receivable[0] : undefined);

    async function recognize(file?: File) {
        if (!file) return;
        setBusy(true);
        try {
            const form = new FormData();
            form.set("image", file);
            const response = await fetch("/api/receipt/ocr", {method: "POST", body: form});
            const json = await response.json() as { courierNo: string; matches?: PurchaseOrder[]; error?: string };
            if (!response.ok) throw new Error(json.error || "识别失败");
            setCourier(json.courierNo);
            setLookedUp(json.matches ?? []);
            setPickedId("");
            setStage("result");
            onNotify(json.matches?.length ? `面单识别完成，反查到 ${json.matches.length} 笔采购单` : "面单识别完成");
        } catch (error) {
            onNotify(error instanceof Error ? error.message : "识别失败");
        } finally {
            setBusy(false);
        }
    }

    useEffect(() => {
        if (stage !== "result" || normalizeCourierNo(courier).length < 8) return;
        const timer = window.setTimeout(() => {
            void fetch(`/api/receipt/ocr?courierNo=${encodeURIComponent(courier)}`).then(async response => {
                const json = await response.json() as { matches?: PurchaseOrder[]; error?: string };
                if (response.ok) setLookedUp(json.matches ?? []);
            }).catch(() => undefined);
        }, 400);
        return () => window.clearTimeout(timer);
    }, [courier, stage]);

    if (stage === "capture") return <Modal title="拍照识别收货" subtitle="VISION RECEIPT" onClose={onClose}><label
        className="camera-zone"><input type="file" accept="image/*" capture="environment" disabled={busy}
                                       onChange={e => void recognize(e.target.files?.[0])}/><i>📷</i><b>{busy ? "正在识别面单…" : "对准快递面单拍摄"}</b><span>图片发送到已配置的智能识图服务，识别后按运单号反查采购单</span></label><label
        className="secondary-upload"><input type="file" accept="image/*" disabled={busy}
                                            onChange={e => void recognize(e.target.files?.[0])}/>从相册选择</label>
        <button className="text-button" onClick={onManual}>或手动输入快递单号查询</button>
    </Modal>;
    return <Modal title="识别结果" subtitle="MATCH RESULT" onClose={onClose}>
        <div className="recognized-card">
            <div><b>📷 面单已识别</b><Badge tone={match ? "green" : "orange"}>{match ? "识别成功" : "识别完成"}</Badge></div>
            <label><span>快递单号</span><input value={courier} onChange={e => {
                setCourier(e.target.value);
                setPickedId("");
            }}/></label></div>
        {receivable.length > 1 && !pickedId && <div className="candidate-card"><h3>关联到 {receivable.length} 笔在途采购订单，请选择要入库的一笔</h3>{receivable.map(order =>
            <div key={order.id}><span><b>{order.itemCount > 1 ? `${order.title} 等${order.itemCount}件` : `${order.title} ${order.items[0]?.size}码`}</b><small>{order.platform} · {order.purchaser} · {money(order.amount)}</small></span>
                <button onClick={() => setPickedId(order.id)}>选择此单</button>
            </div>)}</div>}
        {match ? <div className="match-card"><h3>✓ 关联到 {receivable.length > 1 ? "所选" : "1 笔"}采购订单</h3><KeyValue label="货品"
                                                                             value={match.itemCount > 1 ? `${match.title} 等${match.itemCount}件商品` : `${match.title} ${match.items[0]?.size}码`}/><KeyValue
            label="商品清单" value={<SkuList items={match.items}/>}/><KeyValue label="采购订单号" value={match.id}
                                                                           copyValue={match.id}/><KeyValue label="渠道"
                                                                                                           value={`${match.platform} · ${match.platformNo || "未填写"}`}
                                                                                                           copyValue={match.platformNo || undefined}/><KeyValue
            label="采购物流" value={<PurchaseCourierList items={match.items} showItem/>}/><KeyValue label="采购员 / 时间"
                                                                                                value={`${match.purchaser} · ${dateTime(match.createdAt)}`}/><KeyValue
            label="采购金额" value={money(match.amount)}/><LocationPicker location={location} recentLocations={recentLocations} onChange={setLocation}/>
            <button className="primary-button" disabled={!location.trim()} onClick={() => location.trim() && onReceive(match.id, location.trim())}>核对无误，确认入库
            </button>
        </div> : matches.length > 0 && receivable.length === 0 ? <div className="unmatched"><h3>! 已反查到采购订单，但当前不是在途状态</h3>
            <p>{matches.map(order => `${order.id}（${order.status} · ${order.purchaser}）`).join("、")}。只有在途订单可以入库。</p>
        </div> : <Unmatched orders={orders} courier={courier} onBind={id => {
            const order = [...orders, ...lookedUp].find(item => item.id === id);
            if (order) {
                setCourier(order.items[0]?.purchaseCourierNo || order.courierNo || courier);
                setPickedId(id);
                onNotify("已绑定候选订单");
            }
        }} onAbnormal={() => onNotify("已标记为异常包裹")}/>}</Modal>;
}

function Unmatched({
                       orders,
                       courier,
                       onBind,
                       onAbnormal
                   }: { orders: PurchaseOrder[]; courier: string; onBind: (id: string) => void; onAbnormal: () => void }) {
    const candidates = findTransitCandidatesByCourierTail(orders, courier);
    const fallback = candidates.length ? candidates : orders.filter(o => o.status === "在途").slice(0, 2);
    const tail = normalizeCourierNo(courier).slice(-4);
    return <>
        <div className="unmatched"><h3>! 未找到关联采购订单</h3><p>可能原因：采购员未填快递单号，或单号识别有误。</p></div>
        {fallback.length > 0 && <div className="candidate-card"><h3>{candidates.length ? `尾号 ${tail} 的在途订单` : "可绑定的在途订单"}</h3>{fallback.map(o => <div key={o.id}><span><b>{o.itemCount > 1 ? `${o.title} 等${o.itemCount}件` : `${o.title} ${o.items[0]?.size}码`}</b><small>{o.platform} · {o.purchaser} · {money(o.amount)}</small></span>
            <button onClick={() => onBind(o.id)}>绑定此单</button>
        </div>)}</div>}
        <button className="secondary-button" onClick={onAbnormal}>标记为异常包裹</button>
    </>;
}

function ScanSheet({
                       orders,
                       recentLocations,
                       onClose,
                       onReceive,
                       onNotify
                   }: { orders: PurchaseOrder[]; recentLocations: string[]; onClose: () => void; onReceive: (id: string, loc: string) => void; onNotify: (t: string) => void }) {
    const [value, setValue] = useState("");
    const [location, setLocation] = useState("");
    const match = orders.find(o => o.status === "在途" && (o.items.some(item => item.purchaseCourierNo.includes(value)) || o.id.includes(value) || o.items.some(item => item.sku.toLowerCase().includes(value.toLowerCase()))) && value.length >= 4);
    return <Modal title="扫码 / 手输入库" subtitle="QUICK RECEIPT" onClose={onClose}>
        <div className="scanner-box">
            <div className="scan-beam"/>
            <i>⌗</i><b>对准包裹条码</b><span>扫码枪输入后将自动匹配</span></div>
        <label className="modal-field"><span>订单号 / 快递单号 / 货号后四位</span><input value={value}
                                                                             onChange={e => setValue(e.target.value)}
                                                                             placeholder="请输入至少 4 位"/></label>{match &&
        <div className="match-card compact-match"><h3>匹配到 1 笔在途订单</h3><KeyValue label="采购订单号" value={match.id}
                                                                                copyValue={match.id}/><KeyValue
            label="商品"
            value={match.itemCount > 1 ? `${match.title} 等${match.itemCount}件商品` : `${match.title} ${match.items[0]?.size}码`}/><KeyValue
            label="商品货号" value={<SkuList items={match.items}/>}/><KeyValue label="渠道"
                                                                           value={`${match.platform} · ${match.platformNo || "未填写"}`}
                                                                           copyValue={match.platformNo || undefined}/><KeyValue
            label="采购物流" value={<PurchaseCourierList items={match.items} showItem/>}/><KeyValue label="采购员"
                                                                                                value={match.purchaser}/><LocationPicker location={location} recentLocations={recentLocations} onChange={setLocation}/>
            <button className="primary-button" disabled={!location.trim()} onClick={() => location.trim() && onReceive(match.id, location.trim())}>确认入库</button>
        </div>}{value.length >= 4 && !match &&
        <div className="inline-warning"><b>未匹配到在途订单</b><span>请检查输入，或使用拍照识别功能。</span></div>}
        <button className="text-button" onClick={() => onNotify("扫码枪已进入等待状态")}>连接扫码枪</button>
    </Modal>;
}

function OrderImages({
                         images,
                         title = "订单图片",
                         variant = "order",
                         subtitle,
                         emptyText,
                         actionLabel,
                         onAction
                     }: { images: OrderImage[]; title?: string; variant?: "order" | "settlement"; subtitle?: string; emptyText?: string; actionLabel?: string; onAction?: () => void }) {
    const [selected, setSelected] = useState<number | null>(null);
    const [zoomed, setZoomed] = useState(false);
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const element = dialog.current;
        if (selected !== null && element && !element.open) element.showModal();
        if (selected === null && element?.open) element.close();
    }, [selected]);
    if (!images.length && !emptyText) return null;
    return <section className={`order-images ${variant === "settlement" ? "settlement-proof-gallery" : ""}`}>
        <div className="order-images-head"><div><h3>{title}</h3>{subtitle && <small>{subtitle}</small>}</div>
            <div className="order-images-head-actions"><span>{images.length ? `${images.length} 张` : "未上传"}</span>
                {onAction && actionLabel && <button type="button" onClick={onAction}>{actionLabel}</button>}</div></div>
        {images.length ? <div className="order-images-grid">{images.map((image, index) => <button type="button" key={image.id}
            onClick={() => {setZoomed(false); setSelected(index);}} aria-label={`预览图片 ${index + 1}`} title={image.fileName}><Image
            src={image.url} alt={image.fileName} width={180} height={132}
            unoptimized/><small>{image.uploadedBy}上传</small></button>)}</div> :
            <div className="order-images-empty"><i>▧</i><span>{emptyText}</span></div>}
        <dialog ref={dialog} className="image-preview" aria-label="订单图片预览"
            onCancel={() => setSelected(null)} onClose={() => setSelected(null)}>
            {selected !== null && <div className="image-preview-layout">
                <header><span>{selected + 1} / {images.length}</span></header>
                <div key={`${selected}-${zoomed}`} className={`image-preview-content ${zoomed ? "zoomed" : ""}`}>
                    <Image src={images[selected].url} alt={images[selected].fileName} width={1179} height={2556} unoptimized/>
                </div>
                <footer>
                    <button type="button" disabled={selected === 0} onClick={() => {setZoomed(false); setSelected(selected - 1);}}>上一张</button>
                    <button type="button" onClick={() => setZoomed(value => !value)}>{zoomed ? "适应屏幕" : "放大查看"}</button>
                    <button type="button" onClick={() => setSelected(null)}>关闭图片 ×</button>
                    <button type="button" disabled={selected === images.length - 1} onClick={() => {setZoomed(false); setSelected(selected + 1);}}>下一张</button>
                </footer>
            </div>}
        </dialog>
    </section>;
}

function ManualReceiveSheet({
                                order,
                                recentLocations,
                                onClose,
                                onSubmit
                            }: { order: PurchaseOrder; recentLocations: string[]; onClose: () => void; onSubmit: (id: string, location: string, files: File[]) => Promise<void> }) {
    const [location, setLocation] = useState(""), [files, setFiles] = useState<File[]>([]), [busy, setBusy] = useState(false);

    async function confirm() {
        if (!location.trim() || busy) return;
        setBusy(true);
        try {
            await onSubmit(order.id, location.trim(), files);
        } finally {
            setBusy(false);
        }
    }

    return <Modal title="手动确认入库" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}>
        <div className="detail-card edge-orange">
            <div className="detail-title">
                <h3>{orderTitleWithQuantity(order)}</h3>
                <Badge tone="orange">在途</Badge></div>
            <KeyValue label="采购渠道 / 单号" value={`${order.platform} · ${order.platformNo || "未填写"}`}
                      copyValue={order.platformNo || undefined}/><KeyValue label="商品清单" value={<SkuList
            items={order.items}/>}/><KeyValue label="采购员" value={order.purchaser}/><KeyValue label="采购物流"
                                                                                             value={<PurchaseCourierList
                                                                                                 items={order.items}
                                                                                                 showItem/>}/></div>
        <OrderImages images={order.images}/><LocationPicker location={location} recentLocations={recentLocations} onChange={setLocation}/><label className="receipt-upload"><input type="file" accept="image/*" multiple
                                                    onChange={e => setFiles(Array.from(e.target.files ?? []).slice(0, 3))}/><i>＋</i><span><b>{files.length ? `已选择 ${files.length} 张入库截图` : "入库截图（选填）"}</b><small>最多 3 张、单张不超过 5MB</small></span></label>
        <button className="primary-button receive-confirm-button" disabled={!location.trim() || busy}
                onClick={() => void confirm()}>{busy ? "正在入库…" : "确认入库并增加库存"}</button>
        <p className="form-footnote manual-receive-note">确认后订单将变为“已入库”，对应 SKU 库存同步增加。</p></Modal>;
}

function OrderDetail({
                         order,
                         canManage,
                         showLocation,
                         onClose,
                         onApprove,
                         onReceive,
                         onRevertReceive,
                         onReject,
                         onSettle,
                         onSettlementAmount,
                         onSettlementProof,
                         onShipItem
                     }: { order: PurchaseOrder; canManage: boolean; showLocation: boolean; onClose: () => void; onApprove: () => void; onReceive: () => void; onRevertReceive: () => void; onReject: () => void; onSettle: () => void; onSettlementAmount: () => void; onSettlementProof: () => void; onShipItem: (itemId: string) => void }) {
    const {dateTime} = useServerClock();
    return <Modal title="订单详情" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}>
        <div className={`detail-card edge-${statusTone[order.status]}`}>
            <div className="detail-title">
                <h3>{orderTitleWithQuantity(order)}</h3>
                <Badge tone={statusTone[order.status]}>{canManage ? statusLabel(order.status) : order.status}</Badge>
            </div>
            <KeyValue label="采购渠道" value={order.platform}/><KeyValue label="平台单号" value={order.platformNo || "未填写"}
                                                                     copyValue={order.platformNo || undefined}/><KeyValue
            label="采购总额" value={money(order.amount)}/><KeyValue label="采购员"
                                                                value={`${order.purchaser} · ${dateTime(order.createdAt)}`}/>{canManage && order.purchaserWechatId &&
            <KeyValue label="采购员微信号" value={order.purchaserWechatId}
                      copyValue={order.purchaserWechatId}/>} {canManage && order.purchaserPhone &&
            <KeyValue label="采购员手机号" value={order.purchaserPhone} copyValue={order.purchaserPhone}/>}<KeyValue
            label="采购物流" value={<PurchaseCourierList items={order.items}
                                                     showItem={order.items.length > 1}/>}/>{order.items.some(item => item.purchaseCourierNo) &&
            <KeyValue label="物流轨迹" value={<TrackingPanel items={order.items}/>}/>}{showLocation && order.location &&
            <KeyValue label="库位" value={order.location}/>}<KeyValue label="采购结款"
            value={order.settled ? `已结款 · ${order.settledAmount != null ? money(order.settledAmount) : "金额未记录"} · ${dateTime(order.settledAt)}` : order.receivedAt ? "待结款" : "入库后可结款"}
            highlight={order.settled}/></div>
        <div className="detail-card items-card">
            <div className="items-card-head"><h3>商品清单</h3><span>{orderQuantity(order)} 件 · {money(order.amount)}</span></div>
            {order.items.map((item, index) => <div className={`item-row ${canManage && item.shipped ? "shipped" : ""}`}
                                                   key={item.id}>
                <div className="item-row-lead">
                    <i className="item-index">{index + 1}</i>
                    <div className="item-row-main">
                        <div className="item-row-top"><b>{item.title}</b><span className="item-amount"><em>{money(item.amount)}</em>{item.qty > 1 &&
                            <small className="item-unit-price">单价 {money(unitPrice(item))}</small>}</span></div>
                        <div className="item-sku-meta"><CopyNumber value={item.sku} label="商品货号"/><span>· {item.size}码 · ×{item.qty}</span>
                        </div>
                    </div>
                    {canManage && readyToShip(order.status) && !item.shipped &&
                        <button className="item-ship-button" onClick={() => onShipItem(item.id)}>发货</button>}
                    {canManage && item.shipped &&
                        <button className="item-edit-button" onClick={() => onShipItem(item.id)}>改物流</button>}
                </div>
                {canManage && item.shipped && <div className="item-ship-block">
                    <div className="item-ship-line"><span>发货运单</span><b>{item.outboundCourier ? <span
                        className="copy-number"><span>{[item.outboundCompany, item.outboundCourier].filter(Boolean).join(" · ")}</span><CopyButton
                        value={item.outboundCourier} label="发货运单号"/></span> : "未填写"}</b></div>
                    {(item.resaleNo || item.salePrice) && <div className="item-ship-line resale">
                        <span>{item.resalePlatform || "二级平台"}</span><b>{item.resaleNo || "未填单号"}{item.salePrice ?
                        <em>{money(item.salePrice)}</em> : null}</b></div>}
                </div>}
            </div>)}
        </div>
        <OrderImages images={order.images}/>
        {order.settled && <OrderImages images={order.settlementProofs} title="结款截图" variant="settlement"
                                      subtitle={`已结款 · ${order.settledAmount != null ? money(order.settledAmount) : "金额未记录"} · ${dateTime(order.settledAt)}`} emptyText="本次结款未上传截图"
                                      actionLabel={canManage ? order.settlementProofs.length ? "更换截图" : "补传截图" : undefined}
                                      onAction={canManage ? onSettlementProof : undefined}/>}
        {canManage && order.settled && <button className="settlement-amount-edit" onClick={onSettlementAmount}>¥ 编辑结款金额</button>}
        <div className="timeline-card"><h3>流转记录</h3>
            <ol>
                <li><b>{dateTime(order.createdAt)}</b><span>{order.purchaser}上传订单</span></li>
                {order.status !== "待审核" && order.status !== "已驳回" &&
                    <li><b>{dateTime(order.approvedAt)}</b><span>管理员审核通过</span></li>}{order.receivedAt &&
                <li><b>{dateTime(order.receivedAt)}</b><span>收货入库{showLocation && order.location ? ` · ${order.location}` : ""}</span></li>}{canManage && order.items.some(item => item.resaleNo) &&
                <li><b>未记录</b><span>二级平台成交时间未单独记录</span></li>}{order.settled &&
                <li><b>{dateTime(order.settledAt)}</b><span>{order.settledByName || "管理员"}完成采购结款{order.settledAmount != null ? ` · ${money(order.settledAmount)}` : ""}</span></li>}</ol>
        </div>
        {canManage && canRejectOrder(order) && order.status !== "待审核" &&
        <button className="primary-button danger-button"
                onClick={onReject}>驳回采购单</button>}{canManage && order.status === "待审核" && <div className="dual-actions">
        <button className="secondary-danger" onClick={onReject}>驳回</button>
        <button className="primary-button" onClick={onApprove}>审核通过</button>
    </div>}{canManage && order.status === "在途" &&
        <button className="primary-button receive-confirm-button" onClick={onReceive}>📦
            手动确认入库</button>}{canManage && order.receivedAt && !order.settled &&
        <button className="primary-button settlement-confirm-button" onClick={onSettle}>¥ 确认采购结款</button>}{canManage && !order.settled && readyToShip(order.status) && !order.items.some(item => item.shipped) &&
        <button className="revert-receive-button" onClick={onRevertReceive}>↩ 退回在途（撤销入库）</button>}</Modal>;
}

function SettlementSheet({
                             order,
                             onClose,
                             onSubmit
                         }: { order: PurchaseOrder; onClose: () => void; onSubmit: (id: string, amount?: number, proof?: File) => Promise<boolean> }) {
    const [busy, setBusy] = useState(false), [proof, setProof] = useState<File | null>(null);
    const [amount, setAmount] = useState(""), [recognizing, setRecognizing] = useState(false), [recognitionMessage, setRecognitionMessage] = useState("");
    const proofInput = useRef<HTMLInputElement>(null);
    const recognitionRequest = useRef(0);
    const parsedAmount = amount.trim() ? Number(amount) : undefined;
    const amountInvalid = parsedAmount != null && (!Number.isFinite(parsedAmount) || parsedAmount <= 0);

    async function recognizeProof(file: File) {
        const requestId = ++recognitionRequest.current;
        setRecognitionMessage("");
        if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
            setRecognitionMessage("请选择 5MB 以内的结款截图");
            return;
        }
        setRecognizing(true);
        try {
            const form = new FormData();
            form.set("image", file);
            const response = await fetch("/api/settlements/recognize", {method: "POST", body: form});
            const json = await response.json() as { data?: { amount: number }; error?: string };
            if (!response.ok || !json.data) throw new Error(json.error || "结款金额识别失败");
            if (recognitionRequest.current !== requestId) return;
            setAmount(json.data.amount.toFixed(2));
            setRecognitionMessage(`已识别 ${money(json.data.amount)}，请核对后确认`);
        } catch (error) {
            if (recognitionRequest.current === requestId) setRecognitionMessage(error instanceof Error ? error.message : "未识别出金额，请手动输入");
        } finally {
            if (recognitionRequest.current === requestId) setRecognizing(false);
        }
    }

    async function confirm() {
        if (busy || recognizing || amountInvalid) return;
        setBusy(true);
        try {
            await onSubmit(order.id, parsedAmount, proof ?? undefined);
        } finally {
            setBusy(false);
        }
    }

    return <Modal title="确认采购结款" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}>
        <div className="settlement-confirm-card"><i>¥</i><div><b>确认已向采购员完成结款？</b>
            <p>本单采购金额为 {money(order.amount)}。结款状态独立记录，不会发货、扣减库存或改变当前发货状态。</p></div></div>
        <div className="settlement-summary"><span>采购员</span><b>{order.purchaser}</b><span>当前发货状态</span>
            <b>{order.status === "已发货" ? "已全部发货" : order.items.some(item => item.shipped) ? "部分已发货" : "未发货"}</b></div>
        <label className="settlement-amount-field"><span>实际结款金额 <em>选填</em></span>
            <div><i>¥</i><input value={amount} inputMode="decimal" placeholder="请输入结款金额（选填）"
                               onChange={event => {setAmount(event.target.value.replace(/[^\d.]/g, "")); setRecognitionMessage("");}}/></div>
            <small>{amountInvalid ? "请输入有效的正数金额，或留空后直接确认" : "上传截图后会自动识别并回填，也可以留空后直接确认"}</small>
        </label>
        <div className="settlement-proof-field">
            <label className={`receipt-upload settlement-proof-upload ${proof ? "selected" : ""}`}>
                <input ref={proofInput} type="file" accept="image/*" disabled={busy || recognizing}
                       onChange={event => {const file = event.target.files?.[0] ?? null; setProof(file); if (file) void recognizeProof(file);}}/>
                <i>{recognizing ? "…" : proof ? "✓" : "＋"}</i><span><b>{proof ? proof.name : "上传结款截图（选填）"}</b>
                <small>{recognizing ? "正在识别结款金额…" : proof ? "已选择，点击可更换图片" : "最多 1 张、图片不超过 5MB"}</small></span>
            </label>
            {proof && <button type="button" className="settlement-proof-clear" disabled={busy}
                              onClick={() => {recognitionRequest.current += 1; setRecognizing(false); setProof(null); setRecognitionMessage(""); if (proofInput.current) proofInput.current.value = "";}}>移除截图</button>}
        </div>
        {recognitionMessage && <p className={`settlement-recognition ${recognitionMessage.startsWith("已识别") ? "success" : "failed"}`}>{recognitionMessage}</p>}
        <div className="dual-actions settlement-confirm-actions">
            <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
            <button className="primary-button settlement-confirm-button" disabled={busy || recognizing || amountInvalid}
                    onClick={() => void confirm()}>{busy ? "正在结款…" : recognizing ? "正在识别金额…" : proof ? "确认结款并保存截图" : "确认已结款"}</button>
        </div>
    </Modal>;
}

function SettlementAmountSheet({
                                   order,
                                   onClose,
                                   onSubmit
                               }: { order: PurchaseOrder; onClose: () => void; onSubmit: (id: string, amount?: number) => Promise<boolean> }) {
    const [amount, setAmount] = useState(order.settledAmount?.toFixed(2) ?? ""), [busy, setBusy] = useState(false);
    const parsedAmount = amount.trim() ? Number(amount) : undefined;
    const amountInvalid = parsedAmount != null && (!Number.isFinite(parsedAmount) || parsedAmount <= 0);

    async function confirm() {
        if (busy || amountInvalid) return;
        setBusy(true);
        try {
            await onSubmit(order.id, parsedAmount);
        } finally {
            setBusy(false);
        }
    }

    return <Modal title="编辑结款金额" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}>
        <div className="settlement-confirm-card settlement-amount-edit-card"><i>¥</i><div><b>修改已结款订单的金额</b>
            <p>只更新实际结款金额，不会改变结款状态、原结款时间、结款截图或发货信息。</p></div></div>
        <label className="settlement-amount-field"><span>实际结款金额 <em>选填</em></span>
            <div><i>¥</i><input value={amount} inputMode="decimal" placeholder="留空则显示金额未记录"
                               onChange={event => setAmount(event.target.value.replace(/[^\d.]/g, ""))}/></div>
            <small>{amountInvalid ? "请输入有效的正数金额，或清空后保存" : "可以补填、修改，也可以清空已有金额"}</small>
        </label>
        <div className="dual-actions settlement-confirm-actions">
            <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
            <button className="primary-button settlement-confirm-button" disabled={busy || amountInvalid}
                    onClick={() => void confirm()}>{busy ? "正在保存…" : "保存结款金额"}</button>
        </div>
    </Modal>;
}

function SettlementProofSheet({
                                  order,
                                  onClose,
                                  onSubmit
                              }: { order: PurchaseOrder; onClose: () => void; onSubmit: (id: string, proof: File, amount?: number | null) => Promise<boolean> }) {
    const [proof, setProof] = useState<File | null>(null), [busy, setBusy] = useState(false);
    const [amount, setAmount] = useState(order.settledAmount?.toFixed(2) ?? "");
    const [recognizing, setRecognizing] = useState(false), [recognitionMessage, setRecognitionMessage] = useState("");
    const recognitionRequest = useRef(0);
    const parsedAmount = amount.trim() ? Number(amount) : null;
    const amountInvalid = parsedAmount != null && (!Number.isFinite(parsedAmount) || Math.round(parsedAmount * 100) <= 0 || Math.round(parsedAmount * 100) > 2_147_483_647);

    useEffect(() => () => { recognitionRequest.current += 1; }, []);

    async function chooseProof(file: File | null) {
        const requestId = ++recognitionRequest.current;
        setRecognitionMessage("");
        setRecognizing(false);
        if (!file) { setProof(null); return; }
        if (!file.type.startsWith("image/") || file.size === 0 || file.size > 5 * 1024 * 1024) {
            setProof(null);
            setRecognitionMessage("请选择 5MB 以内的结款截图");
            return;
        }
        setProof(file);
        setRecognizing(true);
        try {
            const form = new FormData();
            form.set("image", file);
            const response = await fetch("/api/settlements/recognize", {method: "POST", body: form});
            const json = await response.json() as { data?: { amount: number }; error?: string };
            if (!response.ok || !json.data || !Number.isFinite(json.data.amount) || json.data.amount <= 0) throw new Error(json.error || "未识别出金额，请手动输入");
            if (recognitionRequest.current !== requestId) return;
            setAmount(json.data.amount.toFixed(2));
            setRecognitionMessage(`已识别 ${money(json.data.amount)}，请核对后保存`);
        } catch (error) {
            if (recognitionRequest.current === requestId) setRecognitionMessage(`${error instanceof Error ? error.message : "识别失败"}；已保留当前金额，可手动修改`);
        } finally {
            if (recognitionRequest.current === requestId) setRecognizing(false);
        }
    }

    async function confirm() {
        if (!proof || busy || recognizing || amountInvalid) return;
        setBusy(true);
        try {
            await onSubmit(order.id, proof, parsedAmount === (order.settledAmount ?? null) ? undefined : parsedAmount);
        } finally {
            setBusy(false);
        }
    }

    return <Modal title={order.settlementProofs.length ? "更换结款截图" : "补传结款截图"} subtitle={order.id}
                  subtitleCopyValue={order.id} onClose={onClose}>
        <div className="settlement-proof-repair-note"><i>▧</i><div><b>上传截图后自动识别结款金额</b>
            <p>请核对金额后保存。原结款时间和发货状态保持不变。</p></div></div>
        {order.settlementProofs.length > 0 && <OrderImages images={order.settlementProofs} title="当前结款截图" variant="settlement"/>}
        <label className="settlement-amount-field"><span>实际结款金额 <em>选填</em></span>
            <div><i>¥</i><input value={amount} inputMode="decimal" disabled={busy || recognizing} placeholder="留空则显示金额未记录"
                               onChange={event => {setAmount(event.target.value.replace(/[^\d.]/g, "")); setRecognitionMessage("");}}/></div>
            <small>{amountInvalid ? "请输入有效的正数金额，或留空清除" : "自动识别后可手动修改；留空保存将清除已有金额"}</small>
        </label>
        <label className={`receipt-upload settlement-proof-upload ${proof ? "selected" : ""}`}>
            <input type="file" accept="image/*" disabled={busy || recognizing}
                   onChange={event => {void chooseProof(event.target.files?.[0] ?? null); event.target.value = "";}}/>
            <i>{proof ? "✓" : "＋"}</i><span><b>{proof ? proof.name : order.settlementProofs.length ? "选择新的结款截图" : "选择要补传的结款截图"}</b>
            <small>{recognizing ? "正在识别结款金额…" : "最多 1 张、图片不超过 5MB"}</small></span>
        </label>
        {recognitionMessage && <p role="status" className={`settlement-recognition ${recognitionMessage.startsWith("已识别") ? "success" : "failed"}`}>{recognitionMessage}</p>}
        <div className="dual-actions settlement-confirm-actions">
            <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
            <button className="primary-button settlement-confirm-button" disabled={busy || !proof || recognizing || amountInvalid}
                    onClick={() => void confirm()}>{busy ? "正在保存…" : recognizing ? "正在识别金额…" : "确认保存截图和金额"}</button>
        </div>
    </Modal>;
}

function RevertReceiveSheet({
                                order,
                                onClose,
                                onSubmit
                            }: { order: PurchaseOrder; onClose: () => void; onSubmit: (id: string) => Promise<boolean> }) {
    const [busy, setBusy] = useState(false);

    async function confirm() {
        if (busy) return;
        setBusy(true);
        try {
            await onSubmit(order.id);
        } finally {
            setBusy(false);
        }
    }

    return <Modal title="退回在途" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}>
        <div className="modal-product">
            <b>{order.itemCount > 1 ? `${order.title} 等${order.itemCount}件商品` : `${order.title} · ${order.items[0]?.size}码`}</b><span>{order.platform} · 当前库位 {order.location || "未记录"}</span>
        </div>
        <div className="revert-warning"><i>↩</i>
            <div><b>确定把该订单退回“在途”？</b>
                <p>入库时增加的 {order.items.reduce((sum, item) => sum + item.qty, 0)} 件库存将同步扣回，库位与入库时间会被清空，并留下一条库存调整流水。退回后可重新执行入库。</p>
            </div>
        </div>
        <div className="dual-actions">
            <button className="secondary-button revert-cancel" disabled={busy} onClick={onClose}>取消</button>
            <button className="primary-button revert-confirm" disabled={busy}
                    onClick={() => void confirm()}>{busy ? "正在退回…" : "确认退回在途"}</button>
        </div>
    </Modal>;
}

function RejectSheet({
                         order,
                         onClose,
                         onSubmit
                     }: { order: PurchaseOrder; onClose: () => void; onSubmit: (id: string, reason: string) => void }) {
    const [reason, setReason] = useState("");
    return <Modal title="驳回订单" subtitle={order.id} subtitleCopyValue={order.id} onClose={onClose}>
        <div className="modal-product">
            <b>{order.itemCount > 1 ? `${order.title} 等${order.itemCount}件商品` : `${order.title} · ${order.items[0]?.size}码`}</b><span>{order.platform} · {money(order.amount)}</span>
        </div>
        {readyToShip(order.status) && <p className="inline-warning">驳回后将撤销该采购单入库并回退库存，采购员修改后需重新审核和入库。</p>}<label
        className="modal-field"><span>驳回原因（必填）</span><textarea value={reason} onChange={e => setReason(e.target.value)}
                                                               placeholder="请说明需要采购员修改的内容"/></label>
        <div className="reason-chips">{["平台单号有误", "商品信息不完整", "采购价格异常"].map(v => <button key={v}
                                                                                        onClick={() => setReason(v)}>{v}</button>)}</div>
        <button className="primary-button danger-button" disabled={!reason}
                onClick={() => onSubmit(order.id, reason)}>确认驳回
        </button>
    </Modal>;
}

function DeleteOrdersSheet({
                               count,
                               onClose,
                               onSubmit
                           }: { count: number; onClose: () => void; onSubmit: () => Promise<void> }) {
    const [busy, setBusy] = useState(false);

    async function confirm() {
        setBusy(true);
        try {
            await onSubmit();
        } finally {
            setBusy(false);
        }
    }

    return <Modal title="批量删除订单" subtitle="DANGER ZONE" onClose={onClose}>
        <div className="delete-warning"><i>!</i>
            <div><b>确定删除选中的 {count} 笔订单？</b><p>订单、库存批次和附件记录将同步处理。已入库但未发货的订单会同时扣减对应库存，此操作不可撤销。</p></div>
        </div>
        <div className="dual-actions">
            <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
            <button className="primary-button danger-button" disabled={busy}
                    onClick={() => void confirm()}>{busy ? "正在删除…" : "确认批量删除"}</button>
        </div>
    </Modal>;
}

function BatchSettlementSheet({
                                  orders,
                                  onClose,
                                  onSubmit
                              }: { orders: PurchaseOrder[]; onClose: () => void; onSubmit: () => Promise<void> }) {
    const [busy, setBusy] = useState(false);
    const purchaseAmount = orders.reduce((sum, order) => sum + order.amount, 0);

    async function confirm() {
        if (busy || !orders.length) return;
        setBusy(true);
        try {
            await onSubmit();
        } finally {
            setBusy(false);
        }
    }

    return <Modal title="批量确认结款" subtitle={`${orders.length} 笔可结款订单`} onClose={onClose}>
        <div className="settlement-confirm-card batch-settlement-card"><i>¥</i><div><b>确认批量完成采购结款？</b>
            <p>将把选中的 {orders.length} 笔已入库订单标记为已结款，不会改变订单发货状态。</p></div></div>
        <div className="settlement-summary"><span>结款订单</span><b>{orders.length} 笔</b><span>采购总金额</span><b>{money(purchaseAmount)}</b></div>
        <p className="batch-settlement-note">批量结款不记录每笔实际结款金额和结款截图；订单详情将显示“金额未记录”。</p>
        <div className="dual-actions settlement-confirm-actions">
            <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
            <button className="primary-button settlement-confirm-button" disabled={busy || !orders.length}
                    onClick={() => void confirm()}>{busy ? "正在批量结款…" : `确认结款 ${orders.length} 笔`}</button>
        </div>
    </Modal>;
}

function BatchShipSheet({
                            orders,
                            onClose,
                            onSubmit
                        }: { orders: PurchaseOrder[]; onClose: () => void; onSubmit: (shipments: Array<{ orderId: string; courier: string; company: string }>) => Promise<void> }) {
    const [company, setCompany] = useState("顺丰速运"), [customCompany, setCustomCompany] = useState(""), [courier, setCourier] = useState(""), [busy, setBusy] = useState(false);
    const resolvedCompany = company === "其他" ? customCompany.trim() : company;
    const complete = Boolean(resolvedCompany && courier.trim()) && orders.length > 0;

    async function confirm() {
        if (!complete || busy) return;
        setBusy(true);
        try {
            await onSubmit(orders.map(order => ({
                orderId: order.id,
                courier: courier.trim(),
                company: resolvedCompany
            })));
        } finally {
            setBusy(false);
        }
    }

    return <Modal title="批量发货" subtitle={`${orders.length} ORDERS`} onClose={onClose}>
        <div className="batch-ship-note"><b>整批共用一个发货运单</b><span>以下 {orders.length} 笔订单将使用同一物流公司和运单号；提交后全部待发货商品将一次性出库，任意订单失败时整批不会生效。</span></div>
        <label className="modal-field"><span>发货物流公司 *</span><select value={company}
                                                                    onChange={e => setCompany(e.target.value)}>{courierCompanies.map(item =>
            <option key={item}>{item}</option>)}
            <option>其他</option>
        </select></label>{company === "其他" &&
        <label className="modal-field"><span>其他物流公司 *</span><input value={customCompany}
                                                                   onChange={e => setCustomCompany(e.target.value)}
                                                                   placeholder="请输入物流公司名称"/></label>}
        <label className="modal-field"><span>发货运单号 *</span><input aria-label="批量发货运单号" value={courier}
                                                                    onChange={e => setCourier(e.target.value)}
                                                                    placeholder="只需填写一个运单号"/></label>
        <div className="batch-shipment-list shared-courier">{orders.map((order, index) => <div key={order.id}>
            <span><b>{index + 1}. {order.itemCount > 1 ? `${order.title} 等${order.itemCount}件` : `${order.title} · ${order.items[0]?.size}码`}</b><small><CopyNumber
                value={order.id} label="采购订单号"/></small></span><em>{order.items.reduce((sum, item) => sum + item.qty, 0)} 件</em></div>)}</div>
        <button className="primary-button" disabled={!complete || busy}
                onClick={() => void confirm()}>{busy ? "正在批量发货…" : `确认批量发货 ${orders.length} 笔`}</button>
    </Modal>;
}

function ShipSheet({
                       order,
                       item,
                       onClose,
                       onSubmit
                   }: { order: PurchaseOrder; item: OrderItem; onClose: () => void; onSubmit: (itemId: string, shipped: boolean, resale: string, price: number, courier: string, company: string, resalePlatform: string) => void }) {
    const initialCompany = item.outboundCompany ?? "";
    const [resalePlatform, setResalePlatform] = useState(item.resalePlatform ?? "得物"), [resale, setResale] = useState(item.resaleNo ?? ""), [price, setPrice] = useState(item.salePrice?.toString() ?? ""), [company, setCompany] = useState(courierCompanyChoice(initialCompany)), [customCompany, setCustomCompany] = useState(courierCompanyChoice(initialCompany) === "其他" ? initialCompany : ""), [courier, setCourier] = useState(item.outboundCourier ?? "");
    const resolvedCompany = company === "其他" ? customCompany.trim() : company, editingShipping = Boolean(item.shipped);
    return <Modal title={editingShipping ? "编辑发货信息" : "更新发货信息"} subtitle={order.id} subtitleCopyValue={order.id}
                  onClose={onClose}>
        <div className="modal-product">
            <b>{item.title} · {item.size}码</b><span>{editingShipping ? "修改预估售价与物流不会重复扣减库存" : `库位 ${order.location} · 当前采购价 ${money(item.amount)}`}</span>
        </div>
        {!editingShipping &&
            <div className="field-grid"><label className="modal-field"><span>二级平台</span><select value={resalePlatform}
                                                                                                onChange={e => setResalePlatform(e.target.value)}>
                <option>得物</option>
                <option>闲鱼</option>
                <option>其他</option>
            </select></label><label className="modal-field"><span>二级平台单号（选填）</span><input value={resale}
                                                                                          onChange={e => setResale(e.target.value)}
                                                                                          placeholder="可暂不填写平台订单号"/></label>
            </div>}<label className="modal-field"><span>预估售价（选填）</span><input inputMode="decimal" value={price}
                                                                              onChange={e => setPrice(e.target.value)}
                                                                              placeholder="可暂不填写售价"/></label>
        <div className="field-grid"><label className="modal-field"><span>发货物流公司 *</span><select value={company}
                                                                                                onChange={e => setCompany(e.target.value)}>{courierCompanies.map(item =>
            <option key={item}>{item}</option>)}
            <option>其他</option>
        </select></label><label className="modal-field"><span>发货运单号 *</span><input value={courier}
                                                                                   onChange={e => setCourier(e.target.value)}
                                                                                   placeholder="请输入发货运单号"/></label>
        </div>
        {company === "其他" && <label className="modal-field"><span>其他物流公司 *</span><input value={customCompany}
                                                                                        onChange={e => setCustomCompany(e.target.value)}
                                                                                        placeholder="请输入物流公司名称"/></label>}{price &&
        <div className="profit-preview"><span>预计单笔毛利</span><b>{money(Math.max(0, Number(price) - item.amount))}</b>
        </div>}
        <button className="primary-button" disabled={!courier.trim() || !resolvedCompany}
                onClick={() => onSubmit(item.id, Boolean(item.shipped), resale, Number(price || 0), courier.trim(), resolvedCompany, resalePlatform)}>{editingShipping ? "保存预估售价与发货物流" : "保存发货信息并扣减库存"}</button>
    </Modal>;
}

/** 搜索记录保存在浏览器本地（每台设备、每个列表独立），最多 10 条，最近使用排在最前。 */
const searchHistoryLimit = 10;

function readSearchHistory(key: string): string[] {
    try {
        const raw = window.localStorage.getItem(`junjun.search.${key}`);
        const list: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, searchHistoryLimit) : [];
    } catch {
        return [];
    }
}

function writeSearchHistory(key: string, list: string[]) {
    try {
        window.localStorage.setItem(`junjun.search.${key}`, JSON.stringify(list.slice(0, searchHistoryLimit)));
    } catch {/* 隐私模式或存储满时静默忽略 */
    }
}

function Search({
                    value,
                    onChange,
                    placeholder,
                    historyKey
                }: { value: string; onChange: (v: string) => void; placeholder: string; historyKey?: string }) {
    const [history, setHistory] = useState<string[]>([]), [focused, setFocused] = useState(false);
    const focus = () => {
        if (historyKey) setHistory(readSearchHistory(historyKey));
        setFocused(true);
    };
    const remember = (term: string) => {
        const trimmed = term.trim();
        if (!historyKey || !trimmed) return;
        setHistory(current => {
            const next = [trimmed, ...current.filter(item => item !== trimmed)].slice(0, searchHistoryLimit);
            writeSearchHistory(historyKey, next);
            return next;
        });
    };
    const forget = (term: string) => {
        if (!historyKey) return;
        setHistory(current => {
            const next = current.filter(item => item !== term);
            writeSearchHistory(historyKey, next);
            return next;
        });
    };
    const forgetAll = () => {
        if (!historyKey) return;
        setHistory([]);
        writeSearchHistory(historyKey, []);
    };
    const keyword = value.trim().toLowerCase();
    const suggestions = history.filter(item => item.toLowerCase() !== keyword && (!keyword || item.toLowerCase().includes(keyword))).slice(0, searchHistoryLimit);
    const open = Boolean(historyKey) && focused && suggestions.length > 0;
    const keepFocus = (event: React.MouseEvent) => event.preventDefault();
    return <div className="search-wrap">
        <label className="search-box"><i>⌕</i><input value={value} onChange={e => onChange(e.target.value)}
                                                     onFocus={focus} onBlur={() => {
            remember(value);
            window.setTimeout(() => setFocused(false), 120);
        }} onKeyDown={e => {
            if (e.key === "Enter") {
                e.preventDefault();
                remember(value);
                e.currentTarget.blur();
            } else if (e.key === "Escape") setFocused(false);
        }} placeholder={placeholder} autoComplete="off"/>{value &&
            <button type="button" aria-label="清空" onMouseDown={keepFocus} onClick={() => onChange("")}>×</button>}
        </label>
        {open && <div className="search-history" aria-label="搜索记录">
            <div className="search-history-head"><span>搜索记录</span>
                <button type="button" onMouseDown={keepFocus} onClick={forgetAll}>清空记录</button>
            </div>
            {suggestions.map(term => <div key={term} className="search-history-item">
                <button type="button" className="search-history-pick" onMouseDown={keepFocus} onClick={() => {
                    onChange(term);
                    remember(term);
                    setFocused(false);
                }}><i>⟲</i><span>{term}</span></button>
                <button type="button" className="search-history-remove" aria-label={`删除记录 ${term}`}
                        onMouseDown={keepFocus} onClick={() => forget(term)}>×
                </button>
            </div>)}
        </div>}
    </div>;
}

function ScrollToTopButton() {
    return <button type="button" className="scroll-top-button" aria-label="回到订单列表顶部" title="回到顶部"
                   onClick={() => window.scrollTo({top: 0, behavior: "smooth"})}><i>↑</i><span>顶部</span></button>;
}

function Badge({tone, children}: { tone: string; children: React.ReactNode }) {
    return <span className={`badge badge-${tone}`}>{children}</span>;
}

function CopyButton({value, label}: { value: string; label: string }) {
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

    async function copy(event: React.MouseEvent<HTMLButtonElement>) {
        event.preventDefault();
        event.stopPropagation();
        try {
            await copyText(value);
            setState("copied");
            window.setTimeout(() => setState("idle"), 1600);
        } catch {
            setState("failed");
            window.setTimeout(() => setState("idle"), 1600);
        }
    }

    return <button type="button" className={`copy-button ${state}`} aria-label={`复制${label} ${value}`}
                   title={`复制${label}`} onClick={event => void copy(event)}
                   onKeyDown={event => event.stopPropagation()}>{state === "copied" ? "✓ 已复制" : state === "failed" ? "复制失败" : "⧉ 复制"}</button>;
}

function CopyNumber({value, label}: { value: string; label: string }) {
    return <span className="copy-number"><span>{value}</span><CopyButton value={value} label={label}/></span>;
}

function SkuList({items}: { items: OrderItem[] }) {
    return <span className="sku-copy-list">{items.map(item => <span key={item.id}><CopyNumber value={item.sku}
                                                                                              label="商品货号"/><small>{item.size}码 · ×{item.qty}</small></span>)}</span>;
}

/** 订单详情「物流轨迹」：直接打开快递100 网页，不调用物流 API。 */
function TrackingPanel({items}: { items: OrderItem[] }) {
    const trackable = items.filter(item => item.purchaseCourierNo);
    return <span className="tracking-panel">{trackable.map(item => <a key={item.id} className="tracking-button"
                                                                     href={courierTrackingUrl(item.purchaseCourierNo)}
                                                                     target="_blank" rel="noopener noreferrer"
                                                                     aria-label={`${item.sku} 查物流`}>{trackable.length > 1 ? `${item.sku} 物流` : "查物流"} ↗</a>)}</span>;
}

function PurchaseCourierList({items, showItem = false}: { items: OrderItem[]; showItem?: boolean }) {
    return <span className="purchase-courier-list">{items.map(item => <span key={item.id}>{showItem &&
        <small>{item.sku}</small>}<span>{item.purchaseCourierCompany}</span><CopyNumber value={item.purchaseCourierNo}
                                                                                        label="采购快递单号"/></span>)}</span>;
}

function KeyValue({
                      label,
                      value,
                      highlight = false,
                      copyValue
                  }: { label: string; value: React.ReactNode; highlight?: boolean; copyValue?: string }) {
    return <div className="key-value"><span>{label}</span><b className={highlight ? "highlight" : ""}>{copyValue ?
        <span className="key-value-copy"><span>{value}</span><CopyButton value={copyValue}
                                                                         label={label}/></span> : value}</b></div>;
}

function Modal({
                   title,
                   subtitle,
                   subtitleCopyValue,
                   onClose,
                   children
               }: { title: string; subtitle: string; subtitleCopyValue?: string; onClose: () => void; children: React.ReactNode }) {
    useEffect(() => {
        const previous = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {document.body.style.overflow = previous;};
    }, []);
    if (typeof document === "undefined") return null;
    return createPortal(<div className="modal-backdrop">
        <section className="modal-sheet" role="dialog" aria-modal="true" aria-label={title}>
            <div className="sheet-handle"/>
            <header>
                <div>{subtitleCopyValue ? <CopyNumber value={subtitleCopyValue} label="采购订单号"/> :
                    <span>{subtitle}</span>}<h2>{title}</h2></div>
                <button type="button" aria-label="关闭" onClick={onClose}>×</button>
            </header>
            <div className="modal-body">{children}</div></section>
    </div>, document.body);
}

function AdminNav({
                      active,
                      onChange,
                      onScan
                  }: { active: AdminTab; onChange: (v: AdminTab) => void; onScan: () => void }) {
    const left: [AdminTab, string, string][] = [["dashboard", "▦", "看板"], ["stock", "◫", "库存"]];
    const right: [AdminTab, string, string][] = [["orders", "▤", "订单"], ["profile", "○", "我的"]];
    return <nav className="bottom-nav">{left.map(([id, icon, label]) => <button key={id}
                                                                                className={active === id ? "active" : ""}
                                                                                onClick={() => onChange(id)}>
        <i>{icon}</i>{label}</button>)}
        <button className="central-scan" aria-label="扫码入库" onClick={onScan}><i>⌗</i><span>入库</span></button>
        {right.map(([id, icon, label]) => <button key={id} className={active === id ? "active" : ""}
                                                  onClick={() => onChange(id)}><i>{icon}</i>{label}</button>)}</nav>;
}

function BuyerNav({active, onChange}: { active: BuyerTab; onChange: (v: BuyerTab) => void }) {
    return <nav className="bottom-nav buyer-nav">
        <button className={active === "home" ? "active" : ""} onClick={() => onChange("home")}><i>⌂</i>首页</button>
        <button className={`buyer-upload ${active === "upload" ? "active" : ""}`} onClick={() => onChange("upload")}>
            <i>＋</i>上传
        </button>
        <button className={active === "mine" ? "active" : ""} onClick={() => onChange("mine")}><i>▤</i>我的订单</button>
    </nav>;
}
