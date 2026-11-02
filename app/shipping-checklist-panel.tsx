"use client";

import {type FormEvent, useEffect, useId, useRef, useState} from "react";
import {checklistSummary, parseShippingChecklist, validateChecklistItems, type ChecklistItem, type ChecklistRecord, type ChecklistSummary} from "@/lib/shipping-checklist";
import {dateKey} from "@/lib/time";
import {useServerClock} from "./server-clock";
import styles from "./shipping-checklist-panel.module.css";

type DraftItem = Omit<ChecklistItem, "qty"> & {qty: number | ""};
type ParseResult = ReturnType<typeof parseShippingChecklist>;
type Mode = "none" | "create" | "edit";

class ChecklistRequestError extends Error {
    constructor(message: string, readonly status: number) {super(message);}
}

async function checklistRequest(url: string, options?: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(url, {cache: "no-store", ...options});
    const value: unknown = await response.json().catch(() => null);
    const data = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    if (!response.ok) throw new ChecklistRequestError(typeof data?.error === "string" ? data.error : "发货清单请求失败，请重试", response.status);
    if (!data) throw new Error("发货清单数据格式异常，请刷新重试");
    return data;
}

function checklistRecord(value: unknown): ChecklistRecord {
    if (!value || typeof value !== "object") throw new Error("清单内容异常，请刷新重试");
    const record = value as ChecklistRecord;
    if (typeof record.id !== "string" || typeof record.title !== "string" || typeof record.sourceText !== "string"
        || typeof record.sourceTimeText !== "string" || !Number.isInteger(record.version) || record.version < 1
        || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string" || !Array.isArray(record.items)
        || validateChecklistItems(record.items).error) throw new Error("清单内容异常，请刷新重试");
    return record;
}

export default function ShippingChecklistPanel({onNotify}: {onNotify: (message: string) => void}) {
    const {now, timeZone, dateTime} = useServerClock();
    const bodyId = useId();
    const [open, setOpen] = useState(false), [activated, setActivated] = useState(false);
    const [page, setPage] = useState(1), [reload, setReload] = useState(0);
    const [batches, setBatches] = useState<ChecklistSummary[]>([]), [total, setTotal] = useState(0), [totalPages, setTotalPages] = useState(1);
    const [loading, setLoading] = useState(false), [detailLoading, setDetailLoading] = useState(false), [busy, setBusy] = useState(false);
    const [listError, setListError] = useState(""), [error, setError] = useState(""), [message, setMessage] = useState("");
    const [selected, setSelected] = useState<ChecklistRecord | null>(null), [mode, setMode] = useState<Mode>("none");
    const [source, setSource] = useState(""), [parsed, setParsed] = useState<ParseResult | null>(null);
    const [title, setTitle] = useState(""), [draft, setDraft] = useState<DraftItem[]>([]);
    const [reviewed, setReviewed] = useState(false), [discarding, setDiscarding] = useState(false), [conflict, setConflict] = useState(false);
    const writing = useRef(false), detailController = useRef<AbortController | null>(null), manualSequence = useRef(0);

    useEffect(() => () => detailController.current?.abort(), []);
    useEffect(() => {
        if (!activated) return;
        const controller = new AbortController();
        void Promise.resolve().then(async () => {
            if (controller.signal.aborted) return;
            setLoading(true); setListError("");
            const data = await checklistRequest(`/api/shipping-checklists?page=${page}`, {signal: controller.signal});
            if (!Array.isArray(data.checklists) || !Number.isInteger(data.page) || !Number.isInteger(data.total) || !Number.isInteger(data.totalPages)) throw new Error("清单列表格式异常，请重试");
            if (controller.signal.aborted) return;
            setBatches(data.checklists as ChecklistSummary[]); setTotal(data.total as number); setTotalPages(data.totalPages as number);
            if (data.page !== page) setPage(data.page as number);
        }).catch(cause => {if (!controller.signal.aborted) setListError(cause instanceof Error ? cause.message : "清单加载失败");})
            .finally(() => {if (!controller.signal.aborted) setLoading(false);});
        return () => controller.abort();
    }, [activated, page, reload]);

    const draftTotal = draft.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    const declaredTotal = mode === "edit" ? selected?.declaredTotal ?? null : parsed?.declaredTotal ?? null;
    const mismatch = declaredTotal !== null && declaredTotal !== draftTotal;
    const needsReview = Boolean(parsed?.unparsedLines.length) || mismatch;
    const locked = busy || detailLoading;

    function startCreate() {
        if (writing.current || locked || mode !== "none") return;
        detailController.current?.abort(); setSelected(null); setMode("create"); setSource(""); setParsed(null);
        setDraft([]); setTitle(`发货清单 ${dateKey(now, timeZone)}`); setError(""); setMessage(""); setReviewed(false); setConflict(false); setDiscarding(false);
    }

    function recognize() {
        if (writing.current || locked) return;
        setError(""); setMessage("");
        if (!source.trim()) {setError("请先粘贴发货文案"); return;}
        if (source.length > 50000) {setError("文案最多 50000 字，请分批导入"); return;}
        const next = parseShippingChecklist(source);
        setParsed(next); setDraft(next.items.map(item => ({...item}))); setReviewed(false);
        if (next.sourceTimeText) setTitle(`发货清单 ${next.sourceTimeText}`.slice(0, 100));
        if (!next.items.length) setError("未识别到商品行，请修改文案或手动添加清单项");
    }

    function updateItem(id: string, patch: Partial<DraftItem>) {
        if (writing.current || locked) return;
        setDraft(current => current.map(item => item.id === id ? {...item, ...patch} : item)); setReviewed(false);
    }

    function addItem() {
        if (writing.current || locked || draft.length >= 200) return;
        const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(++manualSequence.current).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        setDraft(current => [...current, {id: `manual_${id}`, sku: "", title: "", size: "", qty: 1, note: "", completed: false}]);
        setReviewed(false);
    }

    async function openBatch(id: string) {
        if (writing.current || mode !== "none") return;
        detailController.current?.abort();
        const controller = new AbortController(); detailController.current = controller;
        setDetailLoading(true); setError(""); setMessage("");
        try {
            const data = await checklistRequest(`/api/shipping-checklists?id=${encodeURIComponent(id)}`, {signal: controller.signal});
            if (!controller.signal.aborted) {setSelected(checklistRecord(data.checklist)); setConflict(false);}
        } catch (cause) {if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "清单读取失败，请重试");}
        finally {if (!controller.signal.aborted) setDetailLoading(false);}
    }

    function beginEdit() {
        if (!selected || writing.current || locked) return;
        setMode("edit"); setTitle(selected.title); setDraft(selected.items.map(item => ({...item})));
        setParsed(null); setError(""); setMessage(""); setReviewed(false); setDiscarding(false);
    }

    function discard() {
        if (writing.current || locked) return;
        const refreshId = conflict ? selected?.id : undefined;
        setMode("none"); setDraft([]); setParsed(null); setSource(""); setError(""); setDiscarding(false); setConflict(false);
        // After a conflict the latest record is fetched by an explicit user action below.
        if (refreshId) setMessage("草稿已放弃，请点击“刷新当前清单”读取最新版本。");
    }

    function remember(record: ChecklistRecord) {
        setSelected(record);
        setBatches(current => current.map(batch => batch.id === record.id ? checklistSummary(record) : batch));
    }

    async function save(event: FormEvent) {
        event.preventDefault();
        if (writing.current || mode === "none" || detailLoading) return;
        setError("");
        if (!title.trim() || title.trim().length > 100) {setError("请填写 1～100 字的清单名称"); return;}
        const validation = validateChecklistItems(draft);
        if (validation.error) {setError(validation.error); return;}
        if (needsReview && !reviewed) {setError("请先核对未识别内容及合计件数，并勾选确认"); return;}
        if (mode === "create" && !parsed) {setError("请先识别文案并核对清单"); return;}
        writing.current = true; setBusy(true); setMessage("");
        try {
            const creating = mode === "create";
            const body = creating ? {title: title.trim(), sourceText: source, sourceTimeText: parsed!.sourceTimeText, declaredTotal: parsed!.declaredTotal, items: validation.items}
                : {id: selected!.id, version: selected!.version, action: "update", title: title.trim(), items: validation.items};
            const data = await checklistRequest("/api/shipping-checklists", {method: creating ? "POST" : "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
            remember(checklistRecord(data.checklist)); setMode("none"); setDraft([]); setParsed(null); setSource(""); setConflict(false); setDiscarding(false);
            setPage(1); setReload(value => value + 1); setMessage("清单已保存，可逐项勾选完成。"); onNotify("发货清单已保存");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "清单保存失败，草稿已保留");
            if (cause instanceof ChecklistRequestError && cause.status === 409) setConflict(true);
        } finally {writing.current = false; setBusy(false);}
    }

    async function toggle(item: ChecklistItem) {
        if (!selected || writing.current || detailLoading || mode !== "none") return;
        writing.current = true; setBusy(true); setError(""); setMessage("");
        try {
            const data = await checklistRequest("/api/shipping-checklists", {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({id: selected.id, version: selected.version, action: "set-completed", itemId: item.id, completed: !item.completed})});
            remember(checklistRecord(data.checklist)); setConflict(false);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "完成状态保存失败，请重试");
            if (cause instanceof ChecklistRequestError && cause.status === 409) setConflict(true);
        } finally {writing.current = false; setBusy(false);}
    }

    async function copySku(value: string) {
        try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
            else {
                const field = document.createElement("textarea"); field.value = value; field.style.position = "fixed"; field.style.opacity = "0";
                document.body.appendChild(field);
                try {field.focus(); field.select(); if (!document.execCommand("copy")) throw new Error("copy failed");}
                finally {field.remove();}
            }
            onNotify("货号已复制");
        } catch {onNotify("复制失败，请长按货号复制");}
    }

    const summary = selected ? checklistSummary(selected) : null;
    return <section className={styles.panel} aria-label="独立发货清单">
        <button type="button" className={styles.entry} aria-label="发货清单" aria-expanded={open} aria-controls={bodyId}
                onClick={() => {setOpen(value => !value); setActivated(true);}}>
            <i className={styles.icon}>☷</i><span><strong>发货清单</strong><small>粘贴文案 · 逐项核对 · 按批次留存</small></span><em>{open ? "收起 −" : "打开 ＋"}</em>
        </button>
        <div id={bodyId} className={styles.body} hidden={!open}>
            <p className={styles.description}>独立的拣货核对清单；勾选只记录清单完成情况，不改变订单、发货状态或库存。</p>
            <div className={styles.actions}><button type="button" className={styles.primary} disabled={locked || mode !== "none"} onClick={startCreate}>＋ 新建发货清单</button>
                <button type="button" className={styles.secondary} aria-label="刷新发货清单" disabled={locked || loading} onClick={() => setReload(value => value + 1)}>刷新批次</button></div>
            {error && <p className={styles.error} role="alert">{error}</p>}
            {message && <p className={styles.success} role="status">{message}</p>}
            {conflict && <p className={styles.warning}>清单已有更新，当前内容已保留。{mode === "none" ? "请刷新当前清单后再勾选。" : "请核对草稿；取消编辑后可读取最新版本。"}</p>}
            {detailLoading && <p role="status" className={styles.description}>正在读取清单…</p>}

            {mode !== "none" && <form className={styles.editor} onSubmit={event => void save(event)}>
                <h3>{mode === "create" ? "新建清单" : "编辑清单"}</h3>
                {mode === "create" && <><label className={styles.field}><span>粘贴发货文案</span><textarea aria-label="发货文案" rows={7} maxLength={50000}
                    disabled={locked} readOnly={Boolean(parsed)} value={source} onChange={event => setSource(event.target.value)} placeholder={"货号 商品名 尺码规格 数量\n货号 商品名 XS ×2 礼袋\n合计：2件"}/></label>
                    <div className={styles.actions}>{!parsed ? <button type="button" className={styles.primary} disabled={locked || !source.trim()} onClick={recognize}>识别为清单</button>
                        : <button type="button" className={styles.secondary} disabled={locked} onClick={() => {setParsed(null); setReviewed(false);}}>返回文案修改</button>}</div></>}
                {(mode === "edit" || parsed) && <>
                    {parsed && (parsed.warnings.length > 0 || parsed.unparsedLines.length > 0) && <div className={styles.warning} role="status">
                        {parsed.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
                        {parsed.unparsedLines.length > 0 && <details open><summary>未识别内容（请补充或核对后确认）</summary><pre>{parsed.unparsedLines.join("\n")}</pre></details>}
                    </div>}
                    <label className={styles.field}><span>清单名称</span><input aria-label="清单名称" maxLength={100} required disabled={locked} value={title} onChange={event => setTitle(event.target.value)}/></label>
                    <div className={styles.summary}><b>{draft.length} 项 · {draftTotal} 件</b><span>{declaredTotal === null ? "原文未提供合计" : `原文合计：${declaredTotal} 件`}</span>
                        {mismatch && <strong>件数与原文不一致，请核对</strong>}</div>
                    <div className={styles.draftList}>{draft.map((item, index) => <fieldset key={item.id} className={styles.draftItem} disabled={locked}>
                        <legend>第 {index + 1} 项{item.completed ? " · 原已完成，修改内容后需重新核对" : ""}</legend>
                        <div className={styles.grid}><label className={styles.field}><span>货号</span><input aria-label={`第 ${index + 1} 项货号`} maxLength={300} value={item.sku} onChange={event => updateItem(item.id, {sku: event.target.value})}/></label>
                            <label className={styles.field}><span>尺码规格</span><input aria-label={`第 ${index + 1} 项尺码`} maxLength={100} value={item.size} onChange={event => updateItem(item.id, {size: event.target.value})}/></label></div>
                        <label className={styles.field}><span>商品名称</span><input aria-label={`第 ${index + 1} 项商品名`} maxLength={300} value={item.title} onChange={event => updateItem(item.id, {title: event.target.value})}/></label>
                        <div className={styles.grid}><label className={styles.field}><span>数量</span><input aria-label={`第 ${index + 1} 项数量`} type="number" inputMode="numeric" min={1} max={100000} step={1} required value={item.qty} onChange={event => updateItem(item.id, {qty: event.target.value === "" ? "" : Number(event.target.value)})}/></label>
                            <label className={styles.field}><span>备注 / 礼袋</span><input aria-label={`第 ${index + 1} 项备注`} maxLength={500} value={item.note} onChange={event => updateItem(item.id, {note: event.target.value})}/></label></div>
                        <button type="button" className={styles.remove} aria-label={`删除清单项 ${item.id}`} onClick={() => {setDraft(current => current.filter(row => row.id !== item.id)); setReviewed(false);}}>删除此项</button>
                    </fieldset>)}</div>
                    <button type="button" className={styles.secondary} disabled={locked || draft.length >= 200} onClick={addItem}>＋ 添加清单项</button>
                    {needsReview && <label className={styles.review}><input type="checkbox" checked={reviewed} disabled={locked} onChange={event => setReviewed(event.target.checked)}/><span>我已核对未识别内容与合计件数，以当前编辑清单为准保存</span></label>}
                    <button type="submit" className={styles.primary} disabled={locked || !draft.length || !title.trim() || (needsReview && !reviewed)}>{busy ? "正在保存…" : mode === "create" ? "保存清单" : "保存清单修改"}</button>
                </>}
                {!discarding ? <button type="button" className={styles.secondary} disabled={locked} onClick={() => setDiscarding(true)}>{mode === "edit" ? "取消编辑" : "放弃本次清单"}</button>
                    : <div className={styles.warning}><p>尚未保存的内容将被放弃，是否继续？</p><div className={styles.actions}><button type="button" className={styles.secondary} disabled={locked} onClick={() => setDiscarding(false)}>继续编辑</button><button type="button" className={styles.remove} disabled={locked} onClick={discard}>确认放弃</button></div></div>}
            </form>}

            {mode === "none" && selected && summary && <section className={styles.detail} aria-label="清单详情">
                <div className={styles.detailHead}><h3>{selected.title}</h3><span className={summary.completedCount === summary.itemCount ? styles.doneBadge : styles.pendingBadge}>{summary.completedCount === summary.itemCount ? "已完成" : "待核对"}</span></div>
                <p className={styles.metadata}>录入：{dateTime(selected.createdAt)}{selected.sourceTimeText ? ` · 文案时间：${selected.sourceTimeText}` : ""}</p>
                <div className={styles.summary}><b>已完成 {summary.completedCount}/{summary.itemCount} 项</b><span>{summary.completedQty}/{summary.totalQty} 件</span></div>
                <progress aria-label="清单完成进度" max={summary.totalQty || 1} value={summary.completedQty}/>
                <div className={styles.actions}><button type="button" className={styles.secondary} disabled={locked} onClick={beginEdit}>编辑清单</button>
                    <button type="button" className={styles.secondary} disabled={locked} onClick={() => void openBatch(selected.id)}>刷新当前清单</button></div>
                <ul className={styles.items}>{selected.items.map(item => <li key={item.id} className={item.completed ? styles.completedItem : ""}>
                    <label className={styles.check}><input type="checkbox" aria-label={`完成清单项 ${item.id}`} checked={item.completed} disabled={locked} onChange={() => void toggle(item)}/>
                        <span><b>{item.title || item.sku}</b><span>{item.size || "未填规格"} · ×{item.qty}</span>{item.note && <em>{item.note}</em>}</span></label>
                    {item.sku && <div className={styles.sku}><span>货号：{item.sku}</span><button type="button" onClick={() => void copySku(item.sku)}>复制</button></div>}
                </li>)}</ul>
                <details className={styles.original}><summary>查看原始发货文案</summary><pre>{selected.sourceText || "手动录入，无原始文案"}</pre></details>
            </section>}

            <section className={styles.history} aria-label="历史发货批次"><div className={styles.historyHead}><h3>发货批次</h3><span>共 {total} 批 · 每页 10 批</span></div>
                {loading && <p className={styles.description} role="status">正在加载批次…</p>}
                {listError && <div className={styles.error} role="alert">{listError}<button type="button" className={styles.secondary} onClick={() => setReload(value => value + 1)}>重新加载</button></div>}
                {!loading && !listError && !batches.length && <p className={styles.empty}>暂无发货清单，粘贴文案即可创建第一批。</p>}
                <ul>{batches.map(batch => <li key={batch.id}><button type="button" className={`${styles.batch} ${selected?.id === batch.id ? styles.selected : ""}`} aria-label={`打开清单 ${batch.id}`}
                    disabled={locked || mode !== "none"} onClick={() => void openBatch(batch.id)}>
                    <span><b>{batch.title}</b><small>{dateTime(batch.createdAt)}</small></span><span>{batch.completedCount}/{batch.itemCount} 项<small>{batch.totalQty} 件 · {batch.completedCount === batch.itemCount ? "已完成" : "待核对"}</small></span>
                </button></li>)}</ul>
                {totalPages > 1 && <nav className={styles.pagination} aria-label="发货清单分页"><button type="button" className={styles.secondary} disabled={locked || loading || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button>
                    <span>{page}/{totalPages}</span><button type="button" className={styles.secondary} disabled={locked || loading || page >= totalPages} onClick={() => setPage(value => value + 1)}>下一页</button></nav>}
            </section>
        </div>
    </section>;
}
