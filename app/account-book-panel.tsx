"use client";

import {type FormEvent, useEffect, useId, useRef, useState} from "react";
import {parseGrossProfitCents, validAccountingMonth, type MonthlyGrossProfitRecord} from "@/lib/account-book";
import {dateKey} from "@/lib/time";
import {useServerClock} from "./server-clock";
import styles from "./account-book-panel.module.css";

type BookForm = {month: string; grossProfit: string; note: string};

const amountText = (amount: number) => `¥${amount.toLocaleString("zh-CN", {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
const monthText = (month: string) => `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`;
const formForMonth = (month: string, records: MonthlyGrossProfitRecord[]): BookForm => {
    const record = records.find(item => item.month === month);
    return {month, grossProfit: record ? record.grossProfit.toFixed(2) : "", note: record?.note ?? ""};
};

async function readResponse(response: Response): Promise<Record<string, unknown>> {
    const value: unknown = await response.json().catch(() => null);
    const data = value && typeof value === "object" ? value as Record<string, unknown> : null;
    if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "记账请求失败，请重试");
    if (!data) throw new Error("记账本数据格式异常，请重试");
    return data;
}

function isRecord(value: unknown): value is MonthlyGrossProfitRecord {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return typeof item.month === "string" && validAccountingMonth(item.month)
        && typeof item.grossProfit === "number" && Number.isFinite(item.grossProfit)
        && typeof item.note === "string" && typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}

export default function AccountBookPanel({onNotify}: {onNotify: (message: string) => void}) {
    const {now, timeZone, dateTime} = useServerClock();
    const bodyId = useId();
    const [open, setOpen] = useState(false);
    const [hasOpened, setHasOpened] = useState(false);
    const [reloadVersion, setReloadVersion] = useState(0);
    const [records, setRecords] = useState<MonthlyGrossProfitRecord[]>([]);
    const [form, setForm] = useState<BookForm>(() => formForMonth(dateKey(now, timeZone).slice(0, 7), []));
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [saveError, setSaveError] = useState("");
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const saveLock = useRef(false);
    const saveController = useRef<AbortController | null>(null);

    useEffect(() => () => saveController.current?.abort(), []);

    useEffect(() => {
        if (!hasOpened) return;
        const controller = new AbortController();
        void Promise.resolve().then(async () => {
            if (controller.signal.aborted) return;
            setLoading(true);
            setLoaded(false);
            setLoadError("");
            const response = await fetch("/api/account-book", {cache: "no-store", signal: controller.signal});
            const data = await readResponse(response);
            if (!Array.isArray(data.records) || !data.records.every(isRecord)) throw new Error("记账本数据格式异常，请重试");
            if (controller.signal.aborted) return;
            const next = [...data.records].sort((left, right) => right.month.localeCompare(left.month));
            setRecords(next);
            setForm(current => formForMonth(current.month, next));
            setLoaded(true);
        }).catch(cause => {
            if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "记账本加载失败，请重试");
        }).finally(() => {
            if (!controller.signal.aborted) setLoading(false);
        });
        return () => controller.abort();
    }, [hasOpened, reloadVersion]);

    const currentRecord = records.find(item => item.month === form.month);
    const usable = loaded && !loading && !loadError && !busy;
    const validAmount = parseGrossProfitCents(form.grossProfit) !== null;
    const changed = Boolean(currentRecord) && (form.grossProfit !== currentRecord?.grossProfit.toFixed(2) || form.note !== currentRecord?.note);

    function selectMonth(month: string) {
        if (!usable || saveLock.current) return;
        setForm(formForMonth(month, records));
        setSaveError("");
        setMessage("");
    }

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!usable || saveLock.current || !validAccountingMonth(form.month) || !validAmount) return;
        saveLock.current = true;
        const controller = new AbortController();
        saveController.current = controller;
        setBusy(true);
        setSaveError("");
        setMessage("");
        try {
            const response = await fetch("/api/account-book", {
                method: "POST", headers: {"Content-Type": "application/json"}, signal: controller.signal,
                body: JSON.stringify({month: form.month, grossProfit: form.grossProfit.trim(), note: form.note.trim()})
            });
            const data = await readResponse(response);
            if (!isRecord(data.record) || data.record.month !== form.month) throw new Error("保存结果异常，请重试");
            if (controller.signal.aborted) return;
            const record = data.record;
            setRecords(current => [...current.filter(item => item.month !== record.month), record].sort((left, right) => right.month.localeCompare(left.month)));
            setForm(formForMonth(record.month, [record]));
            setMessage(`${monthText(record.month)}的毛利已保存`);
            onNotify("月毛利记录已保存");
        } catch (cause) {
            if (!controller.signal.aborted) setSaveError(cause instanceof Error ? cause.message : "保存失败，请重试");
        } finally {
            saveLock.current = false;
            if (!controller.signal.aborted) setBusy(false);
        }
    }

    return <section className={styles.panel} aria-label="月毛利记账本">
        <button type="button" className={styles.entry} aria-expanded={open} aria-controls={bodyId}
                onClick={() => {setOpen(value => !value); setHasOpened(true);}}>
            <span className={styles.icon} aria-hidden="true">¥</span>
            <span className={styles.entryTitle}><strong>记账本</strong><small>按月记录和编辑毛利</small></span>
            <span className={styles.entryAction}>{open ? "收起" : "打开"}<span aria-hidden="true">{open ? "⌃" : "⌄"}</span></span>
        </button>
        <div id={bodyId} className={styles.body} hidden={!open}>
            <p className={styles.description}>人工记录每月毛利，所有管理员共用一本账。可填正数、零或负数，最多保留两位小数。</p>
            {loading && <p className={styles.loading} role="status">正在加载记账本…</p>}
            {loadError && <div className={styles.error} role="alert"><span>{loadError}</span>
                <button type="button" className={styles.secondary} onClick={() => setReloadVersion(value => value + 1)}>重新加载</button>
            </div>}
            <form className={styles.form} onSubmit={event => void save(event)} aria-busy={busy || loading}>
                <label className={styles.field}><span>记账月份</span><input type="month" value={form.month} required disabled={!usable}
                    min="0001-01" max="9999-12" onChange={event => selectMonth(event.target.value)}/></label>
                <div className={styles.summary}>
                    <span>{validAccountingMonth(form.month) ? monthText(form.month) : "请选择记账月份"}</span>
                    <b>{loaded && !loadError ? currentRecord ? amountText(currentRecord.grossProfit) : "未记录" : "等待加载"}</b>
                    {currentRecord && <small>更新于 {dateTime(currentRecord.updatedAt)}</small>}
                </div>
                <div className={styles.field}><label htmlFor={`${bodyId}-profit`}>月毛利（元）</label>
                    <div className={styles.amountField}><input id={`${bodyId}-profit`} type="text" inputMode="decimal" value={form.grossProfit}
                        required disabled={!usable} autoComplete="off" maxLength={14} placeholder="如 1200.50，亏损填负数"
                        onChange={event => {setForm(current => ({...current, grossProfit: event.target.value})); setSaveError(""); setMessage("");}}/>
                        <button type="button" className={styles.signButton} disabled={!usable} aria-label="切换毛利正负号"
                            onClick={() => {setForm(current => {
                                const amount = current.grossProfit.trim();
                                return {...current, grossProfit: amount.startsWith("-") ? amount.slice(1) : `-${amount.replace(/^\+/, "")}`};
                            }); setSaveError(""); setMessage("");}}>±</button>
                    </div>
                    {form.grossProfit && !validAmount && <small className={styles.validation}>请输入有效金额，最多两位小数</small>}
                </div>
                <label className={styles.field}><span>备注（选填）</span><textarea value={form.note} disabled={!usable} maxLength={500} rows={3}
                    placeholder="记录本月毛利的说明" onChange={event => {setForm(current => ({...current, note: event.target.value})); setSaveError(""); setMessage("");}}/>
                    <small>{form.note.length}/500</small>
                </label>
                {saveError && <p className={styles.error} role="alert">{saveError}</p>}
                {message && <p className={styles.success} role="status">{message}</p>}
                <div className={styles.actions}>
                    {(changed || (!currentRecord && (form.grossProfit || form.note))) && <button type="button" className={styles.secondary}
                        disabled={!usable} onClick={() => {setForm(formForMonth(form.month, records)); setSaveError(""); setMessage("");}}>取消编辑</button>}
                    <button type="submit" className={styles.primary} disabled={!usable || !validAccountingMonth(form.month) || !validAmount}>
                        {busy ? "正在保存…" : currentRecord ? "更新本月记录" : "保存本月记录"}
                    </button>
                </div>
            </form>
            {loaded && !loadError && <div className={styles.history}>
                <div className={styles.historyHead}><h3>历史记录</h3><span>{records.length} 个月</span></div>
                {!records.length ? <p className={styles.empty}>还没有毛利记录，选择月份即可开始记账。</p>
                    : <ul>{records.map(record => <li key={record.month}><button type="button" disabled={!usable}
                        className={`${styles.record} ${record.month === form.month ? styles.selected : ""}`}
                        aria-label={`编辑 ${monthText(record.month)}的毛利记录`} onClick={() => selectMonth(record.month)}>
                        <span className={styles.recordInfo}><strong>{monthText(record.month)}</strong>
                            <small>更新于 {dateTime(record.updatedAt)}</small>{record.note && <span className={styles.note}>{record.note}</span>}
                        </span><span className={styles.recordAmount}><b className={record.grossProfit < 0 ? styles.negative : ""}>{amountText(record.grossProfit)}</b><small>编辑 ›</small></span>
                    </button></li>)}</ul>}
            </div>}
        </div>
    </section>;
}
