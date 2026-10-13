const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);

/** Some mobile pickers omit MIME metadata; detect the image rather than trusting its filename. */
export async function prepareSettlementProof(file: File): Promise<File> {
    if (!file.size || file.size > 5 * 1024 * 1024) throw new Error("请选择非空且不超过 5MB 的结款截图");
    if (supportedTypes.has(file.type)) return file;

    const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const startsWith = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
    const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
    let type = "";
    if (startsWith([0xff, 0xd8, 0xff])) type = "image/jpeg";
    else if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) type = "image/png";
    else if (["GIF87a", "GIF89a"].includes(text(0, 6))) type = "image/gif";
    else if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") type = "image/webp";
    else if (text(4, 8) === "ftyp") {
        const brand = text(8, 12);
        if (["heic", "heix", "hevc", "hevx"].includes(brand)) type = "image/heic";
        else if (["mif1", "msf1"].includes(brand)) type = "image/heif";
    }
    if (!type) throw new Error("未能确认图片格式，请选择 JPG、PNG、WebP、GIF 或 HEIC/HEIF 截图");
    return new File([file], file.name, {type, lastModified: file.lastModified});
}
