export const ORDER_IMAGE_UPLOAD_MAX_FILES = 3;
export const ORDER_IMAGE_UPLOAD_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const ORDER_IMAGE_UPLOAD_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const ORDER_IMAGE_UPLOAD_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif";

const imageTypes = new Set(ORDER_IMAGE_UPLOAD_ACCEPT.split(","));

// Shared by the form and API; keep the aggregate below the proxy's 10MB limit.
export function orderImageUploadError(files: readonly { type: string; size: number }[]): string | null {
  if (!files.length) return "请选择订单图片";
  if (files.length > ORDER_IMAGE_UPLOAD_MAX_FILES) return "每次最多上传 3 张订单图片";
  for (const file of files) {
    if (!imageTypes.has(file.type)) return "仅支持 JPG、PNG、WebP、GIF、HEIC 或 HEIF 图片";
    if (!Number.isSafeInteger(file.size) || file.size <= 0) return "图片不能为空，请重新选择";
    if (file.size > ORDER_IMAGE_UPLOAD_MAX_FILE_BYTES) return "单张订单图片不能超过 5MB";
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > ORDER_IMAGE_UPLOAD_MAX_TOTAL_BYTES) {
    return "每次上传的订单图片总大小不能超过 8MB";
  }
  return null;
}
