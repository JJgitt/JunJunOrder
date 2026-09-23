export type KnowledgeProduct = {
  id: string;
  title: string;
  sku: string;
  aliases: string[];
  source?: "historical" | "approved" | "manual";
};

export type KnowledgeCandidate = {
  id: string;
  title: string;
  sku: string;
  score: number;
};

export type KnowledgeMatch = {
  kind: "auto" | "suggestion" | "none";
  candidates: KnowledgeCandidate[];
};

type RecognizedItem = {
  title: string;
  sku: string;
  skuSource?: "explicit" | "specification" | "title";
};

const genericTitles = new Set([
  "商品名称", "商品信息", "订单商品", "未知商品", "女士上衣", "男士上衣", "女士服装", "男士服装",
  "运动鞋子", "休闲运动鞋", "衣服上衣", "女装上衣", "男装上衣",
]);

const sizeAtEnd = /(?:[\s·,.，、/|;；:：_-]+)(?:尺码|尺寸|码数)?\s*(?:xxxxl|xxxl|xxl|xl|xxxs|xxs|xs|s|m|l|f|free|均码|(?:3[4-9]|4\d)(?:\.5)?)(?:码)?\s*$/i;

function normalizeTitle(value: string): string {
  let result = value.normalize("NFKC").toLowerCase().trim();
  while (sizeAtEnd.test(result)) result = result.replace(sizeAtEnd, "").trim();
  return result.replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeSku(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function isDistinctiveTitle(value: string): boolean {
  return value.length >= 4 && !genericTitles.has(value) && !/^(?:商品|订单|未知|暂无|其他)/.test(value);
}

function isCodeLike(value: string): boolean {
  return /^[A-Z0-9]+$/.test(value) && ((/[A-Z]/.test(value) && /\d/.test(value)) || /^\d{6,}$/.test(value));
}

function titleScore(query: string, reference: string): number {
  if (!isDistinctiveTitle(query) || !reference) return 0;
  if (query === reference) return 0.98;
  if (reference.includes(query)) {
    return 0.86 + Math.min(0.07, (query.length / reference.length) * 0.07);
  }
  if (query.includes(reference) && isDistinctiveTitle(reference)) {
    return 0.8 + Math.min(0.08, (reference.length / query.length) * 0.08);
  }
  return 0;
}

/**
 * Match only product identity. A screenshot's size, quantity and price are never supplied by
 * historical products. Unverified history can suggest a candidate but cannot auto-fill it.
 */
export function matchProductKnowledge(item: RecognizedItem, products: KnowledgeProduct[]): KnowledgeMatch {
  const queryTitle = normalizeTitle(item.title);
  const querySku = normalizeSku(item.sku);
  const skuIsFallback = item.skuSource === "title" || item.skuSource === "specification"
    || querySku === normalizeSku(item.title);
  const canUseSku = !skuIsFallback && querySku.length >= 4
    && (item.skuSource === "explicit" || isCodeLike(querySku));
  const requireMatchingSku = (item.skuSource === "explicit" && Boolean(querySku)) || canUseSku;

  const scored = products.map(product => {
    const names = [product.title, ...product.aliases].map(normalizeTitle);
    const nameScore = Math.max(0, ...names.map(name => titleScore(queryTitle, name)));
    const productSku = normalizeSku(product.sku);
    const realSku = productSku.length >= 4 && productSku !== normalizeSku(product.title);
    const skuScore = canUseSku && realSku && querySku === productSku ? 1 : 0;
    const score = Math.max(nameScore, skuScore);
    return { product, productSku, nameScore, score };
  });
  // A visible SKU is stronger evidence than a similar product name. Never offer a candidate
  // whose SKU conflicts with the screenshot's explicit code: selecting it would replace facts.
  const ranked = scored.filter(candidate => candidate.score > 0 && (!requireMatchingSku || candidate.productSku === querySku))
    .sort((a, b) => b.score - a.score || (a.product.id < b.product.id ? -1 : a.product.id > b.product.id ? 1 : 0));

  if (!ranked.length) return { kind: "none", candidates: [] };
  const candidates = ranked.slice(0, 5).map(({ product, score }) => ({
    id: product.id,
    title: product.title,
    sku: product.sku,
    score: Number(score.toFixed(3)),
  }));
  const [best, second] = ranked;
  const hasCloseCompetitor = Boolean(second && best.score - second.score < 0.08);
  const conflictingTitle = requireMatchingSku && scored.some(candidate =>
    candidate.productSku !== querySku && candidate.nameScore >= 0.86 && candidate.nameScore > best.nameScore + 0.001);
  const verified = best.product.source === "approved" || best.product.source === "manual";
  return {
    kind: verified && best.score >= 0.86 && !hasCloseCompetitor && !conflictingTitle ? "auto" : "suggestion",
    candidates,
  };
}
