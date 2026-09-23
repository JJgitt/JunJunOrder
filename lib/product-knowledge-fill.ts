import type { KnowledgeMatch } from "./product-knowledge-match";

type RecognizedProduct = { title: string; sku: string; skuSource?: "explicit" | "specification" | "title" };

/** Keep the screenshot's transaction fields untouched; knowledge fills product identity only. */
export function fillProductIdentity<T extends RecognizedProduct>(item: T, match: KnowledgeMatch | undefined): T {
  const candidate = match?.kind === "auto" ? match.candidates[0] : undefined;
  if (!candidate) return item;
  return {
    ...item,
    title: candidate.title,
    sku: item.skuSource === "explicit" ? item.sku : candidate.sku,
  };
}
