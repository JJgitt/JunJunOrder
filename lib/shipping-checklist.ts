export const checklistLimits = {items: 200, sourceText: 50000, title: 100, quantity: 100000, total: 20000000} as const;
export type ChecklistItem = {id: string; sku: string; title: string; size: string; qty: number; note: string; completed: boolean};
export type ChecklistRecord = {
    id: string; title: string; sourceText: string; sourceTimeText: string; declaredTotal: number | null;
    items: ChecklistItem[]; version: number; createdAt: string; updatedAt: string;
};
export type ChecklistSummary = Pick<ChecklistRecord, "id" | "title" | "sourceTimeText" | "version" | "createdAt" | "updatedAt"> & {
    itemCount: number; totalQty: number; completedCount: number; completedQty: number;
};
export function checklistSummary(record: ChecklistRecord): ChecklistSummary {
    return {id: record.id, title: record.title, sourceTimeText: record.sourceTimeText, version: record.version,
        createdAt: record.createdAt, updatedAt: record.updatedAt, itemCount: record.items.length,
        totalQty: record.items.reduce((sum, item) => sum + item.qty, 0),
        completedCount: record.items.filter(item => item.completed).length,
        completedQty: record.items.reduce((sum, item) => sum + (item.completed ? item.qty : 0), 0)};
}

export function validateChecklistItems(value: unknown): {items: ChecklistItem[]; error?: undefined} | {error: string; items?: undefined} {
    if (!Array.isArray(value) || !value.length || value.length > checklistLimits.items) return {error: "每份清单需有 1～200 个清单项"};
    const items: ChecklistItem[] = [], ids = new Set<string>();
    for (const [index, raw] of value.entries()) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {error: `第 ${index + 1} 项格式无效`};
        const row = raw as Record<string, unknown>;
        for (const [field, limit] of [["id", 100], ["sku", 300], ["title", 300], ["size", 100], ["note", 500]] as const) {
            if (typeof row[field] !== "string" || row[field].length > limit) return {error: `第 ${index + 1} 项文字字段缺失或过长（货号、名称最多 300 字，规格 100 字，备注 500 字）`};
        }
        const id = (row.id as string).trim(), sku = (row.sku as string).trim(), title = (row.title as string).trim();
        if (!id || ids.has(id)) return {error: "清单项编号不能为空或重复"};
        if (!sku && !title) return {error: `第 ${index + 1} 项至少填写货号或商品名称`};
        if (typeof row.qty !== "number" || !Number.isInteger(row.qty) || row.qty < 1 || row.qty > checklistLimits.quantity) return {error: `第 ${index + 1} 项数量需为 1～100000 的整数`};
        if (typeof row.completed !== "boolean") return {error: `第 ${index + 1} 项完成状态无效`};
        ids.add(id);
        items.push({id, sku, title, size: (row.size as string).trim(), note: (row.note as string).trim(), qty: row.qty, completed: row.completed});
    }
    return {items};
}

export type ParsedShippingChecklist = {items: ChecklistItem[]; sourceTimeText: string; declaredTotal: number | null; totalQty: number; warnings: string[]; unparsedLines: string[]};
/** Parse the explicit size/quantity suffix first; preserve ambiguous product text for human checking. */
export function parseShippingChecklist(text: string): ParsedShippingChecklist {
    const result: ParsedShippingChecklist = {items: [], sourceTimeText: "", declaredTotal: null, totalQty: 0, warnings: [], unparsedLines: []};
    if (text.length > checklistLimits.sourceText) {
        result.warnings.push("文案不能超过 50000 字，请分批导入");
        return result;
    }
    const sizeToken = /^(?:(?:\d{1,3}(?:\.\d{1,2})?|[2-9]?[XSML]{1,6}|F|FREE|ONESIZE|均码|大码|小码)(?:[/-](?:\d{1,3}(?:\.\d{1,2})?|[2-9]?[XSML]{1,6}))?)(?:码)?$/i;
    for (const [index, raw] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
        const line = raw.trim();
        if (!line) continue;
        if (/^(?:货号\s+)?商品(?:名|名称)\s+尺码(?:规格)?\s+数量$/.test(line)) continue;
        const time = line.match(/^(\d{2})(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
        if (time && Number(time[1]) >= 1 && Number(time[1]) <= 12 && Number(time[2]) >= 1 && Number(time[2]) <= [31,29,31,30,31,30,31,31,30,31,30,31][Number(time[1])-1] && Number(time[3]) <= 23 && Number(time[4]) <= 59 && Number(time[5]) <= 59) {
            if (!result.sourceTimeText) result.sourceTimeText = line;
            else if (line !== result.sourceTimeText) {result.warnings.push(`第 ${index + 1} 行出现其他时间，请核对是否混入多份清单`); result.unparsedLines.push(line);}
            continue;
        }
        const footer = line.match(/^(?:合计|总计)\s*[:：]?\s*(\d+)\s*件?$/);
        if (footer && Number(footer[1]) <= checklistLimits.total) {
            const total = Number(footer[1]);
            if (result.declaredTotal !== null && result.declaredTotal !== total) result.warnings.push("文案中出现多个不同的合计，请核对");
            else result.declaredTotal = total;
            continue;
        }
        const marks = [...line.matchAll(/[×xX*＊]\s*(\d+)(?=\s|$)/g)];
        const followsSize = (index: number) => sizeToken.test(line.slice(0, index).trim().split(/\s+/).at(-1) ?? "");
        const eligible = marks.filter(candidate => followsSize(candidate.index) || (candidate.index > 0 && /\s/.test(line[candidate.index - 1])));
        const mark = eligible.find(candidate => followsSize(candidate.index)) ?? eligible[0];
        const prefix = mark ? line.slice(0, mark.index).trim() : "";
        if (!mark || !prefix || Number(mark[1]) < 1 || Number(mark[1]) > checklistLimits.quantity || result.items.length >= checklistLimits.items) {
            result.unparsedLines.push(line);
            continue;
        }
        let product = prefix, size = "";
        const suffix = product.match(/^(.*\S)\s+(\S+)$/);
        if (suffix && sizeToken.test(suffix[2])) {product = suffix[1].trim(); size = suffix[2];}
        else result.warnings.push(`第 ${index + 1} 行未明确识别出尺码，请核对`);
        const identity = product.match(/^(\S+)\s+([\s\S]+)$/);
        const sku = identity ? identity[1] : product, title = identity ? identity[2].trim() : product;
        if (!identity) result.warnings.push(`第 ${index + 1} 行货号与名称未分开，已保留原文，请核对`);
        if (/[;；]/.test(sku)) result.warnings.push(`第 ${index + 1} 行货号可能夹带规格，已保留原文，请核对`);
        if (/…|\.{3}/.test(title)) result.warnings.push(`第 ${index + 1} 行名称有省略内容，请核对`);
        if (eligible.length > 1) result.warnings.push(`第 ${index + 1} 行有多个数量标记，请核对数量和备注`);
        const item = {id: `line-${index + 1}`, sku, title, size, qty: Number(mark[1]), note: line.slice(mark.index + mark[0].length).trim(), completed: false};
        result.items.push(item);
        result.totalQty += item.qty;
    }
    if (result.unparsedLines.length) result.warnings.push(`有 ${result.unparsedLines.length} 行未识别，请核对原文并手动补充，避免漏项`);
    if (result.declaredTotal !== null && result.declaredTotal !== result.totalQty) result.warnings.push(`原文合计 ${result.declaredTotal} 件，已识别 ${result.totalQty} 件，数量不一致`);
    return result;
}
