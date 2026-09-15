import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
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

export async function POST(request: Request) {
  let storedFile: string | null = null;
  try {
    assertSameOrigin(request);
    const user = await requireAppUser(request);
    requireAdmin(user);
    const form = await request.formData();
    const orderId = String(form.get("orderId") ?? "").trim();
    if (!orderId) return Response.json({ error: "缺少订单 ID" }, { status: 400 });

    const proofValue = form.get("proof");
    const proof = proofValue instanceof File && proofValue.size > 0 ? proofValue : null;
    let image: { id: string; objectKey: string; fileName: string; contentType: string; sizeBytes: number } | null = null;
    if (proof) {
      const extension = imageExtension(proof.type);
      if (!extension || proof.size > 5 * 1024 * 1024) {
        return Response.json({ error: "结款凭证仅支持 5MB 以内的 JPG、PNG、WebP、GIF 或 HEIC 图片" }, { status: 400 });
      }
      const id = `img_${crypto.randomUUID()}`;
      const objectKey = `orders/${orderId}/settlement/${id}${extension}`;
      storedFile = uploadPath(objectKey);
      await mkdir(path.dirname(storedFile), { recursive: true });
      await writeFile(storedFile, Buffer.from(await proof.arrayBuffer()), { flag: "wx" });
      image = { id, objectKey, fileName: proof.name || `结款凭证${extension}`, contentType: proof.type, sizeBytes: proof.size };
    }

    const db = getDb();
    const timestamp = new Date().toISOString();
    await db.transaction(async tx => {
      const [order] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, orderId)).for("update").limit(1);
      if (!order) throw new Response(JSON.stringify({ error: "订单不存在" }), { status: 404, headers: { "content-type": "application/json" } });
      if (!order.receivedAt) throw conflict("采购单尚未入库，不能结款");
      if (order.settled) throw conflict("采购单已经完成结款，请勿重复操作");

      if (image) {
        await tx.insert(orderImages).values({ ...image, orderId, kind: "settlement", uploadedBy: user.id, createdAt: timestamp });
      }
      await tx.update(purchaseOrders).set({ settled: true, settledAt: timestamp, settledBy: user.id, updatedAt: timestamp }).where(eq(purchaseOrders.id, orderId));
      await tx.insert(auditLogs).values({
        id: `audit_${crypto.randomUUID()}`,
        actorId: user.id,
        action: "settle",
        entityType: "purchase_order",
        entityId: orderId,
        detailJson: JSON.stringify({ receivedAt: order.receivedAt, shippingIndependent: true, proofImageId: image?.id ?? null }),
        createdAt: timestamp,
      });
    });
    storedFile = null;
    return Response.json({ settled: true, proofUploaded: Boolean(image) });
  } catch (error) {
    if (storedFile) await unlink(storedFile).catch(() => undefined);
    return routeError(error);
  }
}
