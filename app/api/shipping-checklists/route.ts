import {count, desc, eq} from "drizzle-orm";
import {getDb} from "@/db";
import {auditLogs, shippingChecklists} from "@/db/schema";
import {assertSameOrigin, requireAdmin, requireAppUser, routeError} from "@/lib/auth";
import {checklistSummary, validateChecklistItems, type ChecklistItem} from "@/lib/shipping-checklist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = {"cache-control": "no-store"};
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const bad = (error: string) => Response.json({error}, {status: 400, headers});
const missing = () => Response.json({error: "发货清单不存在，请刷新列表"}, {status: 404, headers});
const conflict = () => Response.json({error: "清单已被其他操作更新，请刷新后核对再保存；当前草稿可保留"}, {status: 409, headers});
async function bodyOf(request: Request): Promise<Record<string, unknown>> {
    let value: unknown;
    try {value = await request.json();} catch {throw bad("清单内容格式无效");}
    if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("清单内容格式无效");
    return value as Record<string, unknown>;
}
const sameContent = (left: ChecklistItem, right: ChecklistItem) => left.sku === right.sku && left.title === right.title
    && left.size === right.size && left.qty === right.qty && left.note === right.note;

export async function GET(request: Request) {
    try {
        requireAdmin(await requireAppUser(request));
        const params = new URL(request.url).searchParams;
        const db = getDb();
        if (params.has("id")) {
            const id = string(params.get("id"));
            if (!id || id.length > 100) return bad("清单标识无效");
            const [checklist] = await db.select().from(shippingChecklists).where(eq(shippingChecklists.id, id)).limit(1);
            return checklist ? Response.json({checklist}, {headers}) : missing();
        }
        const requestedPage = Number(params.get("page") ?? 1), pageSize = 10;
        if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 2_147_483_647
            || (params.has("pageSize") && Number(params.get("pageSize")) !== pageSize)) return bad("分页参数无效，每页显示 10 笔清单");
        const result = await db.transaction(async tx => {
            const [counts] = await tx.select({total: count()}).from(shippingChecklists);
            const total = counts.total, totalPages = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(requestedPage, totalPages);
            const rows = total ? await tx.select().from(shippingChecklists)
                .orderBy(desc(shippingChecklists.createdAt), desc(shippingChecklists.id)).limit(pageSize).offset((page - 1) * pageSize) : [];
            return {checklists: rows.map(checklistSummary), page, pageSize, total, totalPages};
        }, {isolationLevel: "repeatable read", accessMode: "read only"});
        return Response.json(result, {headers});
    } catch (error) {return routeError(error);}
}

export async function POST(request: Request) {
    try {
        assertSameOrigin(request);
        const user = await requireAppUser(request);
        requireAdmin(user);
        const body = await bodyOf(request), title = string(body.title);
        if (!title || title.length > 100) return bad("清单标题需填写 1～100 个字");
        if ((body.sourceText !== undefined && typeof body.sourceText !== "string")
            || (body.sourceTimeText !== undefined && typeof body.sourceTimeText !== "string")) return bad("原始文案和时间必须为文字");
        const sourceText = typeof body.sourceText === "string" ? body.sourceText : "", sourceTimeText = string(body.sourceTimeText);
        if (sourceText.length > 50000 || sourceTimeText.length > 40) return bad("原始文案最多 50000 字，时间最多 40 字");
        const declaredTotal = body.declaredTotal ?? null;
        if (declaredTotal !== null && (typeof declaredTotal !== "number" || !Number.isInteger(declaredTotal) || declaredTotal < 0 || declaredTotal > 20000000)) return bad("文案合计件数无效");
        const parsed = validateChecklistItems(body.items);
        if (parsed.error !== undefined) return bad(parsed.error);
        const now = new Date().toISOString(), id = `scl_${crypto.randomUUID()}`;
        const checklist = await getDb().transaction(async tx => {
            const [saved] = await tx.insert(shippingChecklists).values({id, title, sourceText, sourceTimeText, declaredTotal,
                items: parsed.items.map(item => ({...item, completed: false})), version: 1, createdBy: user.id, updatedBy: user.id, createdAt: now, updatedAt: now}).returning();
            await tx.insert(auditLogs).values({id: `audit_${crypto.randomUUID()}`, actorId: user.id, action: "create_shipping_checklist", entityType: "shipping_checklist", entityId: id,
                detailJson: JSON.stringify({after: {title: saved.title, sourceTimeText: saved.sourceTimeText, declaredTotal: saved.declaredTotal, items: saved.items, version: saved.version}, sourceTextLength: sourceText.length}), createdAt: now});
            return saved;
        });
        return Response.json({checklist}, {status: 201, headers});
    } catch (error) {return routeError(error);}
}

export async function PATCH(request: Request) {
    try {
        assertSameOrigin(request);
        const user = await requireAppUser(request);
        requireAdmin(user);
        const body = await bodyOf(request), id = string(body.id), action = string(body.action);
        if (!id || id.length > 100 || typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 1 || body.version >= 2_147_483_647) return bad("清单标识或版本号无效，请刷新后重试");
        if (action !== "update" && action !== "set-completed") return bad("清单操作无效");
        const title = string(body.title), itemId = string(body.itemId);
        const parsed = action === "update" ? validateChecklistItems(body.items) : null;
        if (action === "update" && (!title || title.length > 100)) return bad("清单标题需填写 1～100 个字");
        if (parsed?.error !== undefined) return bad(parsed.error);
        if (action === "set-completed" && (!itemId || itemId.length > 100 || typeof body.completed !== "boolean")) return bad("请选择有效清单项及完成状态");
        const checklist = await getDb().transaction(async tx => {
            const [before] = await tx.select().from(shippingChecklists).where(eq(shippingChecklists.id, id)).for("update").limit(1);
            if (!before) throw missing();
            if (before.version !== body.version) throw conflict();
            let items: ChecklistItem[];
            if (action === "set-completed") {
                if (!before.items.some(item => item.id === itemId)) throw missing();
                items = before.items.map(item => item.id === itemId ? {...item, completed: body.completed as boolean} : item);
            } else {
                const previous = new Map(before.items.map(item => [item.id, item]));
                items = parsed!.items!.map(item => {
                    const original = previous.get(item.id);
                    return {...item, completed: Boolean(original && sameContent(original, item) && original.completed)};
                });
            }
            const now = new Date().toISOString();
            const [saved] = await tx.update(shippingChecklists).set({title: action === "update" ? title : before.title,
                items, version: before.version + 1, updatedBy: user.id, updatedAt: now}).where(eq(shippingChecklists.id, id)).returning();
            const detail = action === "update" ? {
                before: {title: before.title, items: before.items, version: before.version}, after: {title: saved.title, items: saved.items, version: saved.version},
            } : {
                itemId, before: {completed: before.items.find(item => item.id === itemId)!.completed, version: before.version},
                after: {completed: body.completed, version: saved.version},
            };
            await tx.insert(auditLogs).values({id: `audit_${crypto.randomUUID()}`, actorId: user.id, action: action === "update" ? "update_shipping_checklist" : "complete_shipping_checklist_item",
                entityType: "shipping_checklist", entityId: id, detailJson: JSON.stringify(detail), createdAt: now});
            return saved;
        });
        return Response.json({checklist}, {headers});
    } catch (error) {return routeError(error);}
}
