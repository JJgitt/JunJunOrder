"use client";

import {FormEvent, useCallback, useEffect, useMemo, useState} from "react";
import "./product-knowledge-panel.css";

type KnowledgeProduct = {
    id: string;
    title: string;
    sku: string;
    aliases: string[];
    source: "historical" | "approved" | "manual";
    createdAt: string;
    updatedAt: string;
};

type ProductForm = {
    id?: string;
    source?: KnowledgeProduct["source"];
    title: string;
    sku: string;
    aliases: string;
};

const emptyForm: ProductForm = {title: "", sku: "", aliases: ""};

function parseAliases(value: string): string[] {
    const seen = new Set<string>();
    return value.split(/[\n,，;；]+/).map(alias => alias.trim()).filter(alias => {
        const key = alias.toLocaleLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = json && typeof json.error === "string" ? json.error : "请求失败，请重试";
        throw new Error(message);
    }
    return json && typeof json === "object" ? json as Record<string, unknown> : {};
}

export default function ProductKnowledgePanel() {
    const [products, setProducts] = useState<KnowledgeProduct[]>([]);
    const [query, setQuery] = useState("");
    const [form, setForm] = useState<ProductForm | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<KnowledgeProduct | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    const refresh = useCallback(async (signal?: AbortSignal) => {
        const response = await fetch("/api/product-knowledge", {cache: "no-store", signal});
        const json = await readResponse(response);
        if (!Array.isArray(json.products)) throw new Error("商品资料响应格式错误");
        setProducts(json.products as KnowledgeProduct[]);
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        void Promise.resolve().then(() => refresh(controller.signal)).catch(cause => {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "商品资料加载失败");
        }).finally(() => {
            if (!controller.signal.aborted) setLoading(false);
        });
        return () => controller.abort();
    }, [refresh]);

    const visibleProducts = useMemo(() => {
        const keyword = query.trim().toLocaleLowerCase();
        if (!keyword) return products;
        return products.filter(product => [product.title, product.sku, ...product.aliases]
            .some(value => value.toLocaleLowerCase().includes(keyword)));
    }, [products, query]);
    const parsedAliases = form ? parseAliases(form.aliases) : [];
    const aliasError = parsedAliases.length > 10 ? "别名最多填写 10 个" :
        parsedAliases.some(alias => alias.length > 100) ? "每个别名不能超过 100 字" : "";

    async function reload() {
        if (busy || loading) return;
        setLoading(true);
        setError("");
        setMessage("");
        try {
            await refresh();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "商品资料刷新失败");
        } finally {
            setLoading(false);
        }
    }

    function startEdit(product: KnowledgeProduct) {
        setDeleteTarget(null);
        setError("");
        setMessage("");
        setForm({id: product.id, source: product.source, title: product.title, sku: product.sku, aliases: product.aliases.join("\n")});
    }

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!form || busy) return;
        const title = form.title.trim();
        if (!title || !form.sku.trim()) {
            setError("请填写标准商品名称和已确认的货号或款式描述");
            return;
        }
        if (aliasError) {
            setError(aliasError);
            return;
        }
        setBusy(true);
        setError("");
        setMessage("");
        try {
            await readResponse(await fetch("/api/product-knowledge", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({action: "save", id: form.id, title, sku: form.sku.trim(), aliases: parsedAliases})
            }));
            setForm(null);
            setMessage(form.id ? "商品资料已更新" : "商品资料已添加");
            try {
                await refresh();
            } catch {
                setError("已保存，但列表刷新失败，请点击刷新重试");
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "保存失败，请重试");
        } finally {
            setBusy(false);
        }
    }

    async function remove() {
        if (!deleteTarget || busy) return;
        setBusy(true);
        setError("");
        setMessage("");
        try {
            await readResponse(await fetch("/api/product-knowledge", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({action: "delete", id: deleteTarget.id})
            }));
            setDeleteTarget(null);
            setMessage("商品资料已删除");
            try {
                await refresh();
            } catch {
                setError("已删除，但列表刷新失败，请点击刷新重试");
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "删除失败，请重试");
        } finally {
            setBusy(false);
        }
    }

    return <section className="pk-panel" aria-labelledby="pk-title">
        <div className="pk-heading">
            <div>
                <span className="pk-eyebrow">识图辅助</span>
                <h3 id="pk-title">商品知识库</h3>
                <p>核对历史商品候选，维护准确的名称、货号或款式描述，供识图补全参考。</p>
            </div>
            <button className="pk-add" type="button" disabled={busy}
                    onClick={() => { setDeleteTarget(null); setError(""); setMessage(""); setForm({...emptyForm}); }}>
                ＋ 添加商品
            </button>
        </div>

        <div className="pk-tools">
            <label className="pk-search"><span className="sr-only">搜索商品名称、货号或别名</span>
                <input type="search" value={query} onChange={event => setQuery(event.target.value)}
                       placeholder="搜索名称、货号或别名"/>
            </label>
            <button className="pk-refresh" type="button" disabled={loading || busy} onClick={() => void reload()}
                    aria-label="刷新商品资料">刷新</button>
        </div>

        {error && <p className="pk-feedback pk-error" role="alert">{error}</p>}
        {message && <p className="pk-feedback pk-success" role="status">{message}</p>}

        {form && <form className="pk-form" onSubmit={event => void save(event)}>
            <div className="pk-form-head"><h4>{form.source === "historical" ? "核对历史商品资料" : form.id ? "编辑商品资料" : "新增商品资料"}</h4>
                <button type="button" disabled={busy} onClick={() => setForm(null)} aria-label="关闭商品资料表单">×</button>
            </div>
            <label><span>标准商品名称 <em>必填</em></span>
                <input required maxLength={200} value={form.title}
                       onChange={event => setForm(current => current ? {...current, title: event.target.value} : current)}
                       placeholder="如 维秘·波点长袖睡衣套装"/>
            </label>
            <label><span>货号或款式描述 <em>必填</em></span>
                <input required maxLength={100} value={form.sku}
                       onChange={event => setForm(current => current ? {...current, sku: event.target.value} : current)}
                       placeholder="填写已核对的货号或款式描述"/>
            </label>
            <label><span>常见别名 <small>每行一个或用逗号分隔，最多 10 个，每个不超过 100 字</small></span>
                <textarea rows={3} value={form.aliases}
                          onChange={event => setForm(current => current ? {...current, aliases: event.target.value} : current)}
                          placeholder={"如 维秘波点睡衣\n波点长袖"}/>
                <small className={aliasError ? "pk-alias-feedback invalid" : "pk-alias-feedback"} role={aliasError ? "alert" : undefined}>
                    {aliasError || `已填写 ${parsedAliases.length}/10 个别名`}
                </small>
            </label>
            <p className="pk-hint">{form.source === "historical" ? "核对并保存后，这条历史候选会标为已确认。" : "只保存已核对的商品资料。"}资料不足时，识图仍使用规格描述和商品名称兜底。</p>
            <div className="pk-form-actions">
                <button className="pk-cancel" type="button" disabled={busy} onClick={() => setForm(null)}>取消</button>
                <button className="pk-save" type="submit" disabled={busy || !form.title.trim() || !form.sku.trim() || Boolean(aliasError)}>
                    {busy ? "正在保存…" : form.source === "historical" ? "确认并保存" : "保存资料"}
                </button>
            </div>
        </form>}

        <div className="pk-list-head"><b>已收录 {products.length} 款</b><span>{query ? `找到 ${visibleProducts.length} 款` : `历史待核对 ${products.filter(product => product.source === "historical").length} 款`}</span></div>
        {loading ? <p className="pk-empty" role="status">正在加载商品资料…</p> : visibleProducts.length === 0
            ? <p className="pk-empty">{query ? "没有找到匹配的商品" : "暂无商品资料，添加后可供识图补全使用"}</p>
            : <ul className="pk-list">{visibleProducts.map(product => <li key={product.id}>
                <div className="pk-item-main">
                    <div className="pk-item-title"><b>{product.title}</b><small className={product.source === "historical" ? "pk-source historical" : "pk-source"}>
                        {product.source === "historical" ? "历史待核对" : "已确认"}
                    </small></div>
                    <span>货号 / 款式：{product.sku}</span>
                    {product.aliases.length > 0 && <div className="pk-aliases" aria-label="商品别名">
                        {product.aliases.map(alias => <small key={alias}>{alias}</small>)}
                    </div>}
                </div>
                {deleteTarget?.id === product.id ? <div className="pk-delete-confirm" role="group" aria-label={`确认删除 ${product.title}`}>
                    <span>删除这条商品资料？</span>
                    <button type="button" disabled={busy} onClick={() => setDeleteTarget(null)}>取消</button>
                    <button className="pk-danger" type="button" disabled={busy} onClick={() => void remove()}>
                        {busy ? "删除中…" : "确认删除"}
                    </button>
                </div> : <div className="pk-item-actions">
                    <button type="button" disabled={busy} onClick={() => startEdit(product)}>编辑</button>
                    <button type="button" disabled={busy} onClick={() => { setForm(null); setDeleteTarget(product); }}>删除</button>
                </div>}
            </li>)}</ul>}
    </section>;
}
