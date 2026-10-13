import { assertSameOrigin, requireAdmin, requireAppUser, routeError } from "@/lib/auth";
import { recognizeSettlementImage, visionConfigured } from "@/lib/vision";
import { prepareSettlementProof } from "@/lib/settlement-proof-upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function readRawProof(request: Request, type: string): Promise<File> {
  const limit = 5 * 1024 * 1024;
  const tooLarge = () => Response.json({ error: "结款截图超过 5MB，请压缩后再上传" }, { status: 400 });
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > limit) throw tooLarge();
  let name: string;
  try {
    name = decodeURIComponent(request.headers.get("x-settlement-file-name") ?? "settlement-proof");
  } catch {
    throw Response.json({ error: "截图文件名编码无效，请重新选择图片后重试" }, { status: 400 });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof Response) throw error;
      throw Response.json({ error: "无法读取图片内容，请重新选择结款截图" }, { status: 400 });
    } finally {
      reader.releaseLock();
    }
  }
  const contents = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { contents.set(chunk, offset); offset += chunk.byteLength; }
  return new File([contents.buffer], name, { type });
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireAppUser(request);
    requireAdmin(user);
    if (!visionConfigured()) return Response.json({ error: "尚未配置智能识图服务，请手动输入结款金额" }, { status: 501 });
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    let entry: File;
    if (contentType.startsWith("image/") || contentType === "application/octet-stream") {
      // New clients send in-memory bytes directly, avoiding mobile multipart File serialization.
      entry = await readRawProof(request, contentType);
    } else {
      // Keep multipart support for already-open pages and older clients.
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return Response.json({ error: "无法读取结款截图，请重新选择图片后重试" }, { status: 400 });
      }
      const value = form.get("image");
      if (!value || typeof value === "string") {
        console.warn("[vision] settlement upload rejected: missing file", {fieldKind: value == null ? "missing" : "text", contentType, contentLength: request.headers.get("content-length")});
        return Response.json({ error: "未收到结款截图文件，请重新选择图片后重试" }, { status: 400 });
      }
      entry = value;
    }
    let image: File;
    try {
      image = await prepareSettlementProof(entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取结款截图，请重新选择图片后重试";
      console.warn("[vision] settlement upload rejected", {type: entry.type, size: entry.size, reason: message});
      return Response.json({ error: message }, { status: 400 });
    }
    const started = Date.now();
    const data = await recognizeSettlementImage(image);
    console.info(`[vision] settlement user=${user.id} amount=${data.amount} in ${Date.now() - started}ms`);
    return Response.json({ data });
  } catch (error) {
    if (error instanceof Error && /未能识别/.test(error.message)) return Response.json({ error: error.message }, { status: 422 });
    if (error instanceof Error && /尚未配置/.test(error.message)) return Response.json({ error: error.message }, { status: 501 });
    if (error instanceof Error && /识图服务|JSON|模型/.test(error.message)) return Response.json({ error: error.message }, { status: 502 });
    return routeError(error);
  }
}
