/**
 * 智能识图：把电商订单截图或快递面单交给视觉大模型，抽取结构化字段。
 *
 * 适配 OpenAI 兼容的 chat/completions 协议（通义千问 VL、豆包、智谱 GLM-4V、GPT-4o 等均支持），
 * 通过环境变量配置：
 *   VISION_API_BASE  服务地址，如 https://dashscope.aliyuncs.com/compatible-mode/v1
 *   VISION_API_KEY   密钥
 *   VISION_MODEL     模型名，如 qwen-vl-plus
 *
 * 模型只负责"看图抽字段"，字段归一化（渠道名、快递公司名）在本文件用确定性规则完成，便于测试与排错。
 */

export const recognizablePlatforms = ["京东", "拼多多", "淘宝", "唯品会", "抖音", "其他"] as const;
export const recognizableCouriers = ["顺丰速运", "京东物流", "中通快递", "圆通速递", "申通快递", "韵达快递", "极兔速递", "邮政EMS"] as const;

export type RecognizedItem = { title: string; sku: string; size: string; qty: number; amount: number | null };
export type RecognizedOrder = {
  platform: string;
  platformNo: string;
  courierCompany: string;
  courierNo: string;
  items: RecognizedItem[];
  notes: string[];
};

export const visionPrompt = `你是采购订单录入助手。用户会上传一张或多张电商平台（京东、拼多多、淘宝/天猫、唯品会、抖音等）的订单详情、商品列表或物流页截图，这些图片通常属于同一笔订单，请综合所有图片抽取一份采购订单信息。

只输出一个 JSON 对象，不要输出 markdown 代码块或任何解释文字。字段说明：
{
  "platform": "下单平台，只能是 京东 / 拼多多 / 淘宝 / 唯品会 / 抖音 / 其他 之一；天猫归为 淘宝；看不出来填空字符串",
  "platformNo": "平台订单编号，只保留数字和字母；没有则空字符串",
  "courierCompany": "快递/物流公司名称，如 京东快递、顺丰速运、中通快递；没有则空字符串",
  "courierNo": "快递运单号；截图里没有则空字符串，不要编造",
  "items": [
    {
      "title": "商品名称，去掉店铺名、活动词、【】里的促销语，保留品牌与款名",
      "sku": "图片中明确标注的货号/款号/型号，例如 DD1391-100、M9060BE1、273303；未看到或无法确认时填空字符串，不要将颜色、尺码或普通规格文字猜作货号；系统会在货号为空时自动使用商品名称",
      "size": "尺码，如 42、41.5、XS、L、均码；没有填空字符串",
      "qty": 购买数量（整数，默认 1）,
      "amount": 该商品实付金额（数字，单位元）；优先取"实付/到手/合计"金额，找不到填 null
    }
  ],
  "notes": ["对不确定字段的简短说明，没有则为空数组"]
}

规则：
1. 一张或多张截图里有多个商品时 items 输出多个元素，一个商品一个元素；同一商品在多张图里重复出现时只保留一条。
2. 数字字段输出数字类型，不要带货币符号或引号。
3. 看不清或没有的字段按上面说明填空字符串 / null，不要猜。
4. 多张图请合并成一份订单：渠道、订单号、快递信息取最完整的一份，商品行去重后全部保留。
5. 若截图只有物流页、快递面单或运单号，没有商品名称/货号/尺码，items 必须输出空数组，不要编造商品；只填写能看到的快递公司和快递单号，以及能看到的平台、订单号。`;

export const waybillPrompt = `你是快递面单识别助手。用户会上传一张快递面单、物流贴或运单照片，请只抽取快递公司和运单号。

只输出一个 JSON 对象，不要输出 markdown 代码块或任何解释文字。字段说明：
{
  "courierCompany": "快递/物流公司名称，如 京东快递、顺丰速运、中通快递；看不出来填空字符串",
  "courierNo": "运单号，只保留数字和字母，不要空格或横杠；没有则空字符串，不要编造"
}

规则：
1. 只认面单上的运单号/快递单号，不要把手机号、订单号、分拣码、地址或条码旁的无关数字当成运单号。
2. 看不清就填空字符串，不要猜。`;

export const settlementPrompt = `你是采购结款凭证识别助手。用户会上传一张微信、支付宝、银行或其他支付渠道的付款/转账截图，请只提取本次已经成功支付的结款金额。

只输出一个 JSON 对象，不要输出 markdown 代码块或任何解释文字：
{
  "amount": "本次实际付款或转账成功金额，数字类型、单位元；无法确认时填 null"
}

规则：
1. 优先读取明确标注为“转账金额”“付款金额”“支付金额”“实付金额”或成功交易主金额的数值。
2. 不要把账户余额、优惠金额、商品原价、订单号、手续费、收款方账号或日期数字当成结款金额。
3. 金额必须来自图片中的明确文字；看不清、交易失败或无法确认时填 null，不要猜。`;

/** 从模型返回的文本里提取第一个完整的 JSON 对象，容忍 markdown 代码块与前后废话。 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("模型未返回可解析的 JSON");
  return JSON.parse(trimmed.slice(start, end + 1));
}

/** 把模型给出的平台名归一到系统内置的采购渠道；识别不出返回空字符串，表示不覆盖表单。 */
export function normalizePlatform(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "";
  if (/京东|jd/.test(value)) return "京东";
  if (/拼多多|pdd|pinduoduo/.test(value)) return "拼多多";
  if (/淘宝|天猫|taobao|tmall/.test(value)) return "淘宝";
  if (/唯品会|vip/.test(value)) return "唯品会";
  if (/抖音|抖店|douyin|tiktok/.test(value)) return "抖音";
  return "其他";
}

/** 把模型给出的快递公司名归一到系统内置列表；不在列表里的保留原名（前端会落到"其他"并带上名称）。 */
export function normalizeCourierCompany(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (/顺丰|sf/.test(lower)) return "顺丰速运";
  if (/京东/.test(lower)) return "京东物流";
  if (/中通|zto/.test(lower)) return "中通快递";
  if (/圆通|yto/.test(lower)) return "圆通速递";
  if (/申通|sto/.test(lower)) return "申通快递";
  if (/韵达|yunda/.test(lower)) return "韵达快递";
  if (/极兔|j&t|jt/.test(lower)) return "极兔速递";
  if (/邮政|ems|中国邮政/.test(lower)) return "邮政EMS";
  return value;
}

const str = (value: unknown) => String(value ?? "").trim();
const positiveInt = (value: unknown) => { const n = Math.floor(Number(value)); return Number.isFinite(n) && n > 0 ? n : 1; };
const amountOrNull = (value: unknown) => { if (value === null || value === undefined || value === "") return null; const n = Number(String(value).replace(/[¥￥,，\s]/g, "")); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };

export function normalizeSettlementAmount(payload: unknown): number | null {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const amount = amountOrNull(record.amount ?? record.paidAmount ?? record.paymentAmount ?? record.transferAmount);
  return amount !== null && amount > 0 ? amount : null;
}

/** 把模型的原始 JSON 清洗成稳定结构：类型校正、字段归一、去掉空商品行。 */
export function normalizeRecognition(payload: unknown): RecognizedOrder {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items = rawItems
    .map(item => (item && typeof item === "object" ? item as Record<string, unknown> : {}))
    .map(item => ({ title: str(item.title), sku: str(item.sku) || str(item.title), size: str(item.size), qty: positiveInt(item.qty), amount: amountOrNull(item.amount) }))
    .filter(item => item.title || item.sku || item.size)
    .slice(0, 20);
  const notes = (Array.isArray(record.notes) ? record.notes : []).map(str).filter(Boolean).slice(0, 5);
  return {
    platform: normalizePlatform(record.platform),
    platformNo: str(record.platformNo ?? record.orderNo).replace(/[^0-9A-Za-z-]/g, ""),
    courierCompany: normalizeCourierCompany(record.courierCompany),
    courierNo: str(record.courierNo).replace(/\s/g, ""),
    items,
    notes,
  };
}

export function visionConfigured() {
  return Boolean(process.env.VISION_API_BASE && process.env.VISION_API_KEY && process.env.VISION_MODEL);
}

/** 调用视觉模型识别一张或多张订单截图；抛出的 Error.message 可直接展示给用户。 */
export async function recognizeOrderImages(images: File[]): Promise<RecognizedOrder> {
  const files = images.slice(0, 3);
  if (!files.length) throw new Error("请选择订单截图");
  const base = process.env.VISION_API_BASE?.replace(/\/+$/, "");
  const key = process.env.VISION_API_KEY;
  const model = process.env.VISION_MODEL;
  if (!base || !key || !model) throw new Error("尚未配置智能识图服务，请联系管理员在服务器设置 VISION_API_BASE / VISION_API_KEY / VISION_MODEL");
  const imageParts = [];
  for (const image of files) {
    const bytes = Buffer.from(await image.arrayBuffer());
    const dataUrl = `data:${image.type || "image/jpeg"};base64,${bytes.toString("base64")}`;
    imageParts.push({ type: "image_url", image_url: { url: dataUrl } });
  }
  const timeout = Number(process.env.VISION_TIMEOUT_MS) || (files.length > 1 ? 75000 : 45000);
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: visionPrompt },
        { role: "user", content: [...imageParts, { type: "text", text: files.length > 1 ? `以上是同一笔订单的 ${files.length} 张截图，请综合识别后按要求输出一份 JSON。` : "请识别这张订单截图并按要求输出 JSON。" }] },
      ],
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } };
  if (!response.ok) {
    console.error("[vision] upstream error", response.status, body);
    throw new Error(`识图服务调用失败（${response.status}）${body.error?.message ? `：${body.error.message}` : ""}`);
  }
  const content = body.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(part => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "")).join("") : "";
  if (!text) throw new Error("识图服务没有返回内容，请重试");
  return normalizeRecognition(extractJson(text));
}

export async function recognizeOrderImage(image: File): Promise<RecognizedOrder> {
  return recognizeOrderImages([image]);
}

export type RecognizedWaybill = { courierCompany: string; courierNo: string };

/** 识别快递面单上的公司和运单号；抛出的 Error.message 可直接展示给用户。 */
export async function recognizeWaybillImage(image: File): Promise<RecognizedWaybill> {
  const base = process.env.VISION_API_BASE?.replace(/\/+$/, "");
  const key = process.env.VISION_API_KEY;
  const model = process.env.VISION_MODEL;
  if (!base || !key || !model) throw new Error("尚未配置智能识图服务，请联系管理员在服务器设置 VISION_API_BASE / VISION_API_KEY / VISION_MODEL");
  const bytes = Buffer.from(await image.arrayBuffer());
  const dataUrl = `data:${image.type || "image/jpeg"};base64,${bytes.toString("base64")}`;
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: waybillPrompt },
        { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }, { type: "text", text: "请识别这张快递面单并按要求输出 JSON。" }] },
      ],
    }),
    signal: AbortSignal.timeout(Number(process.env.VISION_TIMEOUT_MS) || 45000),
  });
  const body = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } };
  if (!response.ok) {
    console.error("[vision] waybill upstream error", response.status, body);
    throw new Error(`识图服务调用失败（${response.status}）${body.error?.message ? `：${body.error.message}` : ""}`);
  }
  const content = body.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(part => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "")).join("") : "";
  if (!text) throw new Error("识图服务没有返回内容，请重试");
  const record = extractJson(text) as Record<string, unknown>;
  const courierNo = str(record.courierNo ?? record.courier_no).replace(/[\s-]/g, "");
  if (!courierNo) throw new Error("未能识别快递单号，请重新拍照或手动输入");
  return { courierCompany: normalizeCourierCompany(record.courierCompany ?? record.courier_company), courierNo };
}

/** 识别付款/转账截图中的实际结款金额；无法确认时要求管理员手动输入。 */
export async function recognizeSettlementImage(image: File): Promise<{ amount: number }> {
  const base = process.env.VISION_API_BASE?.replace(/\/+$/, "");
  const key = process.env.VISION_API_KEY;
  const model = process.env.VISION_MODEL;
  if (!base || !key || !model) throw new Error("尚未配置智能识图服务，请手动输入结款金额");
  const bytes = Buffer.from(await image.arrayBuffer());
  const dataUrl = `data:${image.type || "image/jpeg"};base64,${bytes.toString("base64")}`;
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: settlementPrompt },
        { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }, { type: "text", text: "请识别截图中本次已成功支付的结款金额，并按要求输出 JSON。" }] },
      ],
    }),
    signal: AbortSignal.timeout(Number(process.env.VISION_TIMEOUT_MS) || 45000),
  });
  const body = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } };
  if (!response.ok) {
    console.error("[vision] settlement upstream error", response.status, body);
    throw new Error(`识图服务调用失败（${response.status}）${body.error?.message ? `：${body.error.message}` : ""}`);
  }
  const content = body.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(part => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "")).join("") : "";
  if (!text) throw new Error("识图服务没有返回内容，请手动输入结款金额");
  const amount = normalizeSettlementAmount(extractJson(text));
  if (amount === null) throw new Error("未能识别结款金额，请手动输入");
  return { amount };
}
