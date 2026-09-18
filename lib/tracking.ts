import { createHash } from "node:crypto";

/** 快递鸟「在途监控即时查询」接口（RequestType=8001）：POST 官方 HTTPS 地址。
 *  按快递鸟 Go 示例：DataSign = Base64(MD5(RequestData + APIKey) 的原始 16 字节)，
 *  URLSearchParams 对 DataSign 和 RequestData 各做一次表单 URL 编码。
 *  环境变量：KDNIAO_EBUSINESS_ID（用户 ID）、KDNIAO_API_KEY（API 密钥）。 */
const KDNIAO_ENDPOINT = "https://api.kdniao.com/Ebusiness/EbusinessOrderHandle.aspx";
const KDNIAO_REQUEST_TYPE_INSTANT = "8001";

/** 应用内快递公司名 → 快递鸟 ShipperCode。未收录的公司走前端快递100网页跳转兜底。 */
const kdniaoShipperCodes: Record<string, string> = {
    "顺丰速运": "SF",
    "京东物流": "JD",
    "中通快递": "ZTO",
    "圆通速递": "YTO",
    "申通快递": "STO",
    "韵达快递": "YD",
    "极兔速递": "JTSD",
    "邮政EMS": "EMS",
    "德邦物流": "DBL",
};

/** 快递鸟物流状态：0 无轨迹、1 已揽收、2 在途中、3 已签收、4 问题件。 */
const kdniaoStateLabels: Record<string, string> = {
    "0": "暂无轨迹",
    "1": "已揽收",
    "2": "在途中",
    "3": "已签收",
    "4": "问题件",
};

export function kdniaoShipperCode(company: unknown): string | null {
    return kdniaoShipperCodes[String(company ?? "").trim()] ?? null;
}

export function kdniaoConfigured(): boolean {
    return Boolean(process.env.KDNIAO_EBUSINESS_ID && process.env.KDNIAO_API_KEY);
}

export function kdniaoDataSign(requestData: string, apiKey: string): string {
    return createHash("md5").update(`${requestData}${apiKey}`, "utf8").digest("base64");
}

export type TrackingTrace = { time: string; station: string; location: string };
export type TrackingResult =
    | { ok: true; stateLabel: string; logisticCode: string; shipperCode: string; traces: TrackingTrace[] }
    | { ok: false; message: string };

type KdniaoTrace = { AcceptTime?: unknown; AcceptStation?: unknown; Location?: unknown };
type KdniaoResponse = { Success?: unknown; Reason?: unknown; State?: unknown; LogisticCode?: unknown; ShipperCode?: unknown; Traces?: unknown };

/** 进程内缓存 10 分钟：同一单号重复查询不消耗快递鸟当日配额（免费版限量）。 */
const trackingCache = new Map<string, { at: number; result: TrackingResult }>();
const TRACKING_CACHE_TTL_MS = 10 * 60 * 1000;

export async function queryTracking({company, logisticCode, customerName = ""}: { company: string; logisticCode: string; customerName?: string }): Promise<TrackingResult> {
    const shipperCode = kdniaoShipperCode(company);
    if (!shipperCode) return { ok: false, message: `暂不支持「${String(company ?? "").trim() || "该快递公司"}」的应用内查询，请改用网页查询` };
    if (!kdniaoConfigured()) return { ok: false, message: "服务器尚未配置快递鸟 API（KDNIAO_EBUSINESS_ID / KDNIAO_API_KEY），请联系管理员" };
    const cacheKey = `${shipperCode}:${logisticCode}:${customerName}`;
    const cached = trackingCache.get(cacheKey);
    if (cached && Date.now() - cached.at < TRACKING_CACHE_TTL_MS) return cached.result;
    // 8001 的基本字段与 Go 示例一致；有校验信息时才附加 CustomerName。
    const requestData = JSON.stringify({ ShipperCode: shipperCode, LogisticCode: logisticCode, ...(customerName ? { CustomerName: customerName } : {}) });
    const body = new URLSearchParams({
        RequestData: requestData,
        EBusinessID: process.env.KDNIAO_EBUSINESS_ID ?? "",
        RequestType: KDNIAO_REQUEST_TYPE_INSTANT,
        DataSign: kdniaoDataSign(requestData, process.env.KDNIAO_API_KEY ?? ""),
        DataType: "2",
    });
    let result: TrackingResult;
    try {
        const response = await fetch(KDNIAO_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
            body: body.toString(),
            signal: AbortSignal.timeout(10000),
            cache: "no-store",
        });
        const payload = await response.json() as KdniaoResponse;
        const success = payload?.Success === true || payload?.Success === "true";
        if (!success) {
            result = { ok: false, message: String(payload?.Reason ?? "快递鸟查询失败，请稍后重试") };
        } else {
            const traces = (Array.isArray(payload?.Traces) ? payload.Traces as KdniaoTrace[] : [])
                .map(trace => ({
                    time: String(trace.AcceptTime ?? "").trim(),
                    station: String(trace.AcceptStation ?? "").trim(),
                    location: String(trace.Location ?? "").trim(),
                }))
                .filter(trace => trace.time || trace.station);
            result = {
                ok: true,
                stateLabel: kdniaoStateLabels[String(payload?.State ?? "0")] ?? "状态未知",
                logisticCode: String(payload?.LogisticCode ?? logisticCode),
                shipperCode: String(payload?.ShipperCode ?? shipperCode),
                traces,
            };
        }
    } catch {
        result = { ok: false, message: "快递鸟接口请求失败，请稍后重试或改用网页查询" };
    }
    // 只缓存成功结果：失败原因（未开通、缺手机号后 4 位等）即时可变，不缓存。
    if (result.ok) {
        if (trackingCache.size > 200) {
            for (const key of trackingCache.keys()) {
                trackingCache.delete(key);
                if (trackingCache.size <= 100) break;
            }
        }
        trackingCache.set(cacheKey, { at: Date.now(), result });
    }
    return result;
}
