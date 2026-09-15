import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, orderImages, purchaseOrders } from "@/db/schema";
import { assertSameOrigin, requireAdmin, requireAppUser, routeError } from "@/lib/auth";
import { imageExtension, uploadPath } from "@/lib/file-storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conflict = (message: string) => new Response(JSON.stringify({ error: message }), {
  status: 409,
  headers: { "content-type": "application/json" },
});

/** 管理员可为已结款订单补传或更换唯一一张结款截图。 */
export async function POST(request: Request) {
  let storedFile: string | null = null;
  try {
    assertSameOrigin(request);
    const user = await requireAppUser(request);
    requireAdmin(user);
    const form = await request.formData();
    const orderId = String(form.get("orderId") ?? "").trim();
    const proof = form.get("proof");
    if (!orderId) return Response.json({ error: "缺少订单 ID" }, { status: 400 });
    if (!(proof instanceof File) || proof.size <= 0) return Response.json({ error: "请选择结款截图" }, { status: 400 });
    const extension = imageExtension(proof.type);
    if (!extension || proof.size > 5 * 1024 * 1024) {
      return Response.json({ error: "结款截图仅支持 5MB 以内的 JPG、PNG、WebP、GIF 或 HEIC 图片" }, { status: 400 });
    }

    const id = `img_${crypto.randomUUID()}`;
    const objectKey = `orders/${orderId}/settlement/${id}${extension}`;
    storedFile = uploadPath(objectKey);
    await mkdir(path.dirname(storedFile), { recursive: true });
    await writeFile(storedFile, Buffer.from(await proof.arrayBuffer()), { flag: "wx" });

    const db = getDb();
    const timestamp = new Date().toISOString();
    const oldObjectKeys = await db.transaction(async tx => {
      const [order] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, orderId)).for("update").limit(1);
      if (!order) throw new Response(JSON.stringify({ error: "订单不存在" }), { status: 404, headers: { "content-type": "application/json" } });
      if (!order.settled) throw conflict("订单尚未结款，不能单独上传结款截图");
      const oldImages = await tx.select({ id: orderImages.id, objectKey: orderImages.objectKey }).from(orderImages)
        .where(and(eq(orderImages.orderId, orderId), eq(orderImages.kind, "settlement"))).for("update");
      if (oldImages.length) await tx.delete(orderImages).where(inArray(orderImages.id, oldImages.map(image => image.id)));
      await tx.insert(orderImages).values({ id, orderId, kind: "settlement", objectKey, fileName: proof.name || `结款截图${extension}`, contentType: proof.type, sizeBytes: proof.size, uploadedBy: user.id, createdAt: timestamp });
      await tx.insert(auditLogs).values({
        id: `audit_${crypto.randomUUID()}`,
        actorId: user.id,
        action: oldImages.length ? "replace_settlement_proof" : "add_settlement_proof",
        entityType: "purchase_order",
        entityId: orderId,
        detailJson: JSON.stringify({ proofImageId: id, replacedImageIds: oldImages.map(image => image.id) }),
        createdAt: timestamp,
      });
      return oldImages.map(image => image.objectKey);
    });
    storedFile = null;
    await Promise.all(oldObjectKeys.map(oldObjectKey => unlink(uploadPath(oldObjectKey)).catch(() => undefined)));
    return Response.json({ proofImageId: id, replaced: oldObjectKeys.length > 0 });
  } catch (error) {
    if (storedFile) await unlink(storedFile).catch(() => undefined);
    return routeError(error);
  }
}
