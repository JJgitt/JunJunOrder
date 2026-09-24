import assert from "node:assert/strict";
import test from "node:test";
import { postReceiptTimelineEvents } from "../lib/order-timeline.ts";
import { timestamp } from "../lib/time.ts";

const at = day => `2026-09-${day}T08:00:00+08:00`;
const summarize = events => events.map(event => ({
  kind: event.kind,
  at: event.at,
  ...(event.kind === "shipped" ? { itemId: event.item.id } : {}),
}));

test("only shipped item rows produce admin shipment events; buyer sees no shipment events", () => {
  const order = {
    items: [
      { id: "pending" },
      { id: "shipped", shippedAt: at("02") },
    ],
    settled: false,
  };
  assert.deepEqual(summarize(postReceiptTimelineEvents(order, true, timestamp)), [
    { kind: "shipped", at: at("02"), itemId: "shipped" },
  ]);
  assert.deepEqual(postReceiptTimelineEvents(order, false, timestamp), []);
});

test("multiple item shipments and independent settlement sort by actual event time", () => {
  const order = {
    items: [
      { id: "later", shippedAt: at("04") },
      { id: "earlier", shippedAt: at("02") },
    ],
    settled: true,
    settledAt: at("03"),
  };
  assert.deepEqual(summarize(postReceiptTimelineEvents(order, true, timestamp)), [
    { kind: "shipped", at: at("02"), itemId: "earlier" },
    { kind: "settled", at: at("03") },
    { kind: "shipped", at: at("04"), itemId: "later" },
  ]);
  assert.deepEqual(summarize(postReceiptTimelineEvents(order, false, timestamp)), [
    { kind: "settled", at: at("03") },
  ]);
  assert.deepEqual(summarize(postReceiptTimelineEvents({ ...order, settledAt: at("01") }, true, timestamp)), [
    { kind: "settled", at: at("01") },
    { kind: "shipped", at: at("02"), itemId: "earlier" },
    { kind: "shipped", at: at("04"), itemId: "later" },
  ]);
});

test("missing or invalid event time follows events with valid timestamps", () => {
  const order = {
    items: [
      { id: "invalid", shippedAt: "not-a-time" },
      { id: "valid", shippedAt: at("02") },
    ],
    settled: true,
  };
  const events = postReceiptTimelineEvents(order, true, timestamp);
  assert.equal(events[0].kind, "shipped");
  assert.equal(events[0].item.id, "valid");
  assert.deepEqual(events.slice(1).map(event => event.kind).sort(), ["settled", "shipped"]);
});

test("editing a shipped item's logistics does not add or retime a shipment event", () => {
  const original = { id: "one", shippedAt: at("02"), outboundCourier: "OLD" };
  const initial = postReceiptTimelineEvents({ items: [original], settled: false }, true, timestamp);
  const afterEdit = postReceiptTimelineEvents({ items: [{ ...original, outboundCourier: "NEW" }], settled: false }, true, timestamp);
  assert.equal(afterEdit.length, 1);
  assert.deepEqual(summarize(afterEdit), summarize(initial));
});
