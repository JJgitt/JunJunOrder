import assert from "node:assert/strict";
import test from "node:test";
import { courierTrackingUrl, findOrdersByCourierNo, findTransitCandidatesByCourierTail, normalizeCourierNo, orderMatchesCourierNo } from "../lib/courier.ts";
import { kdniaoDataSign, kdniaoShipperCode, queryTracking } from "../lib/tracking.ts";

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

test("kdniao 8001 data sign matches the Go sample's raw MD5 bytes then Base64", () => {
  const requestData = JSON.stringify({ ShipperCode: "STO", LogisticCode: "773367326370601" });
  assert.equal(kdniaoDataSign(requestData, "test-api-key"), "bUSNBDTvb9SicbW3itLicQ==");
  assert.notEqual(kdniaoDataSign(requestData, "another-key"), "bUSNBDTvb9SicbW3itLicQ==");
});

test("kdniao 8001 posts a single URL-encoded form to the official HTTPS API", async () => {
  const oldFetch = globalThis.fetch;
  const oldId = process.env.KDNIAO_EBUSINESS_ID;
  const oldKey = process.env.KDNIAO_API_KEY;
  process.env.KDNIAO_EBUSINESS_ID = "synthetic-account";
  process.env.KDNIAO_API_KEY = "test-api-key";
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.kdniao.com/Ebusiness/EbusinessOrderHandle.aspx");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["content-type"], "application/x-www-form-urlencoded;charset=utf-8");
    const form = new URLSearchParams(options.body);
    assert.equal(form.get("EBusinessID"), "synthetic-account");
    assert.equal(form.get("RequestType"), "8001");
    assert.equal(form.get("DataType"), "2");
    assert.equal(form.get("RequestData"), '{"ShipperCode":"STO","LogisticCode":"773367326370601"}');
    assert.equal(form.get("DataSign"), kdniaoDataSign(form.get("RequestData"), "test-api-key"));
    return new Response(JSON.stringify({ Success: true, State: "2", Traces: [{ AcceptTime: "2026-09-18 10:00:00", AcceptStation: "运输中" }] }), { status: 200 });
  };
  try {
    const result = await queryTracking({ company: "申通快递", logisticCode: "773367326370601" });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.stateLabel, "在途中");
    assert.equal(result.traces.length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldId === undefined) delete process.env.KDNIAO_EBUSINESS_ID;
    else process.env.KDNIAO_EBUSINESS_ID = oldId;
    if (oldKey === undefined) delete process.env.KDNIAO_API_KEY;
    else process.env.KDNIAO_API_KEY = oldKey;
  }
});
