import assert from "node:assert/strict";
import test from "node:test";
import { courierTrackingUrl, findOrdersByCourierNo, findTransitCandidatesByCourierTail, normalizeCourierNo, orderMatchesCourierNo } from "../lib/courier.ts";
import { kdniaoDataSign, kdniaoShipperCode } from "../lib/tracking.ts";

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

test("tracking links jump to kuaidi100 web query with normalized numbers", () => {
  assert.equal(courierTrackingUrl("顺丰速运", "sf 1392-0415 8866"),
    "https://www.kuaidi100.com/chaxun?com=shunfeng&nu=SF139204158866");
  assert.equal(courierTrackingUrl("京东物流", "JD014892367120"),
    "https://www.kuaidi100.com/chaxun?com=jd&nu=JD014892367120");
  assert.equal(courierTrackingUrl("极兔速递", "JT5001234567890"),
    "https://www.kuaidi100.com/chaxun?com=jtexpress&nu=JT5001234567890");
  assert.equal(courierTrackingUrl("德邦快递", "DPK123456789"),
    "https://www.kuaidi100.com/chaxun?nu=DPK123456789");
  assert.equal(courierTrackingUrl("顺丰速运", ""), "");
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

test("kdniao data sign follows URLEncode(Base64(MD5(requestData + apiKey)))", () => {
  // 回归向量：MD5 取 UTF-8 小写 32 位 hex → Base64 → URL 编码，防止签名算法被误改。
  const requestData = JSON.stringify({ OrderCode: "", ShipperCode: "SF", LogisticCode: "SF139204158866", CustomerName: "8866" });
  assert.equal(kdniaoDataSign(requestData, "test-api-key"), "YjVjNjU3NmI0YjMzOWZhMzE2NmJhODBkMDYwZjdhYjk%3D");
  // 签名必须区分密钥：换 key 结果必须变化。
  assert.notEqual(kdniaoDataSign(requestData, "another-key"), "YjVjNjU3NmI0YjMzOWZhMzE2NmJhODBkMDYwZjdhYjk%3D");
});
