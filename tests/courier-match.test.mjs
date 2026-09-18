import assert from "node:assert/strict";
import test from "node:test";
import { courierTrackingUrl, findOrdersByCourierNo, findTransitCandidatesByCourierTail, kdniaoShipperCode, normalizeCourierNo, orderMatchesCourierNo } from "../lib/courier.ts";

test("courier numbers compare without spaces, dashes or letter case", () => {
  assert.equal(normalizeCourierNo("sf 1234-5678"), "SF12345678");
  assert.equal(orderMatchesCourierNo({
    courierNo: "SF-1234 5678",
    items: [{ purchaseCourierNo: "772012345678" }],
  }, "sf12345678"), true);
  assert.equal(orderMatchesCourierNo({
    courierNo: "",
    items: [{ purchaseCourierNo: "7720 1234 5678" }],
  }, "772012345678"), true);
});

test("lookup prefers exact tracking matches and tails only for transit candidates", () => {
  const orders = [
    { id: "a", status: "在途", courierNo: "11112222", items: [{ purchaseCourierNo: "11112222" }] },
    { id: "b", status: "在途", courierNo: "", items: [{ purchaseCourierNo: "99992222" }] },
    { id: "c", status: "已入库", courierNo: "11112222", items: [{ purchaseCourierNo: "11112222" }] },
  ];
  assert.deepEqual(findOrdersByCourierNo(orders, "1111-2222").map(order => order.id), ["a", "c"]);
  assert.deepEqual(findTransitCandidatesByCourierTail(orders, "xx2222").map(order => order.id), ["a", "b"]);
});

test("kdniao shipper codes map app courier companies to official codes", () => {
  assert.equal(kdniaoShipperCode("顺丰速运"), "SF");
  assert.equal(kdniaoShipperCode("京东物流"), "JD");
  assert.equal(kdniaoShipperCode("中通快递"), "ZTO");
  assert.equal(kdniaoShipperCode("圆通速递"), "YTO");
  assert.equal(kdniaoShipperCode("申通快递"), "STO");
  assert.equal(kdniaoShipperCode("韵达快递"), "YD");
  assert.equal(kdniaoShipperCode("极兔速递"), "JTSD");
  assert.equal(kdniaoShipperCode("邮政EMS"), "EMS");
  assert.equal(kdniaoShipperCode("德邦物流"), "DBL");
  assert.equal(kdniaoShipperCode("其他"), null);
  assert.equal(kdniaoShipperCode(" 顺丰速运 "), "SF");
  assert.equal(kdniaoShipperCode(""), null);
});

test("tracking links open the free kdniao result page for known couriers", () => {
  assert.equal(courierTrackingUrl("顺丰速运", "sf 1392-0415 8866"),
    "https://www.kdniao.com/JSInvoke/MSearchResult.aspx?expCode=SF&expNo=SF139204158866");
  assert.equal(courierTrackingUrl("京东物流", "JD014892367120", "http://113.46.133.47/?tab=orders"),
    "https://www.kdniao.com/JSInvoke/MSearchResult.aspx?expCode=JD&expNo=JD014892367120&backUrl=http%3A%2F%2F113.46.133.47%2F%3Ftab%3Dorders");
  assert.equal(courierTrackingUrl("极兔速递", "JT5001234567890"),
    "https://www.kdniao.com/JSInvoke/MSearchResult.aspx?expCode=JTSD&expNo=JT5001234567890");
  assert.equal(courierTrackingUrl("顺丰速运", ""), "");
});

test("tracking links fall back to kuaidi100 number recognition for unknown couriers", () => {
  assert.equal(courierTrackingUrl("其他", "DPK123456789"), "https://www.kuaidi100.com/chaxun?nu=DPK123456789");
  assert.equal(courierTrackingUrl("", "1234 5678", "http://113.46.133.47/"), "https://www.kuaidi100.com/chaxun?nu=12345678");
});
