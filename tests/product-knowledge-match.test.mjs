import assert from "node:assert/strict";
import test from "node:test";
import { matchProductKnowledge } from "../lib/product-knowledge-match.ts";

const product = (id, title, sku, extra = {}) => ({ id, title, sku, aliases: [], source: "approved", ...extra });

test("a unique verified title fragment can complete a truncated recognition", () => {
  const match = matchProductKnowledge(
    { title: "维秘·波点…", sku: "维秘·波点…", skuSource: "title" },
    [product("1", "维秘·波点长袖睡衣套装", "VS-BD-001")],
  );
  assert.equal(match.kind, "auto");
  assert.equal(match.candidates[0].id, "1");
});

test("similar long-sleeve and short-sleeve products remain suggestions", () => {
  const match = matchProductKnowledge(
    { title: "维秘波点", sku: "维秘波点", skuSource: "title" },
    [
      product("long", "维秘波点长袖睡衣", "VS-BD-L"),
      product("short", "维秘波点短袖睡衣", "VS-BD-S"),
    ],
  );
  assert.equal(match.kind, "suggestion");
  assert.deepEqual(match.candidates.map(candidate => candidate.id), ["long", "short"]);
});

test("unverified history is a suggestion even for an exact title", () => {
  const match = matchProductKnowledge(
    { title: "维秘波点长袖睡衣", sku: "维秘波点长袖睡衣" },
    [product("old", "维秘波点长袖睡衣", "VS-BD-L", { source: "historical" })],
  );
  assert.equal(match.kind, "suggestion");
});

test("short and generic title fragments are insufficient evidence", () => {
  const catalog = [product("1", "维秘波点长袖睡衣", "VS-BD-L")];
  assert.equal(matchProductKnowledge({ title: "波点", sku: "波点", skuSource: "title" }, catalog).kind, "none");
  assert.equal(matchProductKnowledge({ title: "商品名称", sku: "商品名称", skuSource: "title" }, catalog).kind, "none");
});

test("aliases participate in exact matching", () => {
  const match = matchProductKnowledge(
    { title: "维秘波点睡衣", sku: "维秘波点睡衣", skuSource: "title" },
    [product("1", "维多利亚的秘密波点长袖睡衣", "VS-BD-L", { aliases: ["维秘波点睡衣"] })],
  );
  assert.equal(match.kind, "auto");
});

test("an explicit real SKU matches despite a short screenshot title", () => {
  const match = matchProductKnowledge(
    { title: "睡衣", sku: "VS-BD-001", skuSource: "explicit" },
    [product("1", "维秘波点长袖睡衣", "VS-BD-001")],
  );
  assert.equal(match.kind, "auto");
});

test("an explicit SKU and title pointing to different products require review", () => {
  const match = matchProductKnowledge(
    { title: "维秘波点短袖睡衣", sku: "VS-BD-L", skuSource: "explicit" },
    [
      product("long", "维秘波点长袖睡衣", "VS-BD-L"),
      product("short", "维秘波点短袖睡衣", "VS-BD-S"),
    ],
  );
  assert.equal(match.kind, "suggestion");
  assert.deepEqual(match.candidates.map(candidate => candidate.id), ["long"]);
});

test("a title match cannot override an explicit SKU absent from the catalog", () => {
  const match = matchProductKnowledge(
    { title: "维秘波点长袖睡衣", sku: "VS-NEW-001", skuSource: "explicit" },
    [product("old", "维秘波点长袖睡衣", "VS-BD-L")],
  );
  assert.equal(match.kind, "none");
  assert.deepEqual(match.candidates, []);
});

test("a specification or title fallback never becomes an exact SKU match", () => {
  const catalog = [product("1", "维秘波点长袖睡衣", "夜影黑")];
  assert.equal(matchProductKnowledge({ title: "睡衣", sku: "夜影黑", skuSource: "specification" }, catalog).kind, "none");
  assert.equal(matchProductKnowledge({ title: "睡衣", sku: "维秘波点长袖睡衣", skuSource: "title" }, catalog).kind, "none");
});

test("size suffixes do not decide between otherwise identical products", () => {
  const match = matchProductKnowledge(
    { title: "维秘波点长袖睡衣 · M码", sku: "维秘波点长袖睡衣 · M码", skuSource: "title" },
    [
      product("m", "维秘波点长袖睡衣 · M码", "VS-BD-M"),
      product("l", "维秘波点长袖睡衣 · L码", "VS-BD-L"),
    ],
  );
  assert.equal(match.kind, "suggestion");
  assert.equal(match.candidates.length, 2);
});

test("a knowledge SKU copied from its title is not a real SKU", () => {
  const match = matchProductKnowledge(
    { title: "睡衣", sku: "维秘波点长袖睡衣", skuSource: "explicit" },
    [product("1", "维秘波点长袖睡衣", "维秘波点长袖睡衣")],
  );
  assert.equal(match.kind, "none");
});
