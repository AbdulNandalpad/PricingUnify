const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApi6Client } = require('../src');

/**
 * KIT component fetch — the real API6 getKitComponents contract:
 *   request  { tssArticleNumber, originOfData, warehouseCode, requestorId }
 *   response { status:{statusCode, faultMessage[]}, kitComponentList:{ itemKitComonent:[{ tssArticleNumber,
 *              itemShortNumber, quantity:"0000000020", usage:"S"|"O" }] } }   (sic: "Comonent")
 * Routing: one COMMON endpoint (API6 routes to the ERP by originOfData); individual per-OOD endpoints are an
 * optional config override that can be adopted OOD by OOD.
 */

const realAnswer = {
  status: { statusCode: 'SUCCESS', faultMessage: [] },
  kitComponentList: { itemKitComonent: [
    { tssArticleNumber: 'ORAR00351-N7083', itemShortNumber: 3694, quantity: '0000000020', usage: 'S' },
    { tssArticleNumber: 'PQ0301400-T46', itemShortNumber: 295, quantity: '0000000010', usage: 'S' },
    { tssArticleNumber: 'QRAR04250-N7004', itemShortNumber: 5391, quantity: '0000000010', usage: 'O' },
    { tssArticleNumber: '', quantity: '0000000001' },
  ] },
};
const fakeFetch = (calls, answer = realAnswer, ok = true) => async (url, init) => {
  calls.push({ url, method: init.method, body: JSON.parse(init.body) });
  return { ok, status: ok ? 200 : 503, statusText: ok ? 'OK' : 'Service Unavailable', json: async () => answer };
};

test('live, COMMON endpoint: POSTs the real request body; zero-padded quantities are numbers; only part and quantity are kept (usage/itemShortNumber ignored); unnamed rows dropped', async () => {
  const calls = [];
  const c = createApi6Client({ mode: 'live', baseUrl: 'https://api6.example', fetchImpl: fakeFetch(calls) });
  const res = await c.fetchKitComponents({ ood: 'CN', partNumber: 'PQ0301400-T46NK', warehouse: 'CNSHF1' });
  assert.equal(calls[0].url, 'https://api6.example/core/item/rest/v1/getKitComponents');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { tssArticleNumber: 'PQ0301400-T46NK', originOfData: 'CN', warehouseCode: 'CNSHF1', requestorId: 'FS' });
  assert.equal(res.status, 'OK');
  assert.equal(res.routing, 'COMMON');
  assert.deepEqual(res.components, [
    { partNumber: 'ORAR00351-N7083', quantity: 20 },
    { partNumber: 'PQ0301400-T46', quantity: 10 },
    { partNumber: 'QRAR04250-N7004', quantity: 10 }, // usage "O" is ignored: every component is priced
  ]);
});

test('the warehouse is omitted from the request when unknown (never invented); requestorId is configurable', async () => {
  const calls = [];
  const c = createApi6Client({ mode: 'live', baseUrl: 'https://api6.example', kitRequestorId: 'XY', fetchImpl: fakeFetch(calls) });
  await c.fetchKitComponents({ ood: 'SAP', partNumber: 'K-1' });
  assert.deepEqual(calls[0].body, { tssArticleNumber: 'K-1', originOfData: 'SAP', requestorId: 'XY' });
});

test('INDIVIDUAL endpoints: an OOD with its own endpoint calls it directly, every other OOD keeps the common one (switch OOD by OOD)', async () => {
  const calls = [];
  const c = createApi6Client({ mode: 'live', baseUrl: 'https://api6.example', kitEndpoints: { SMA: '/erp/jde-e1/kits' }, kitEndpoint: '/common/kits', fetchImpl: fakeFetch(calls) });
  const sma = await c.fetchKitComponents({ ood: 'SMA', partNumber: 'K-1' });
  const sap = await c.fetchKitComponents({ ood: 'SAP', partNumber: 'K-2' });
  assert.equal(calls[0].url, 'https://api6.example/erp/jde-e1/kits');
  assert.equal(sma.routing, 'INDIVIDUAL');
  assert.equal(calls[1].url, 'https://api6.example/common/kits');
  assert.equal(sap.routing, 'COMMON');
});

test('a gateway fault or non-SUCCESS status is { status: FAILED, message }, never a throw; an empty list is NOT_FOUND', async () => {
  const down = createApi6Client({ mode: 'live', baseUrl: 'https://x', fetchImpl: fakeFetch([], {}, false) });
  const failed = await down.fetchKitComponents({ ood: 'SAP', partNumber: 'K' });
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.message, /503/);
  assert.deepEqual(failed.components, []);

  const fault = createApi6Client({ mode: 'live', baseUrl: 'https://x', fetchImpl: fakeFetch([], { status: { statusCode: 'FAILED', faultMessage: ['Unknown article'] } }) });
  const f = await fault.fetchKitComponents({ ood: 'SAP', partNumber: 'K' });
  assert.equal(f.status, 'FAILED');
  assert.match(f.message, /Unknown article/);

  const empty = createApi6Client({ mode: 'live', baseUrl: 'https://x', fetchImpl: fakeFetch([], { status: { statusCode: 'SUCCESS', faultMessage: [] }, kitComponentList: { itemKitComonent: [] } }) });
  assert.equal((await empty.fetchKitComponents({ ood: 'SAP', partNumber: 'K' })).status, 'NOT_FOUND');
});

test('a quantity that is not a plain number is passed through unchanged for the engine to reject, never guessed', async () => {
  const c = createApi6Client({ mode: 'live', baseUrl: 'https://x', fetchImpl: fakeFetch([], { status: { statusCode: 'SUCCESS' }, kitComponentList: { itemKitComonent: [{ tssArticleNumber: 'A', quantity: 'abc' }] } }) });
  assert.equal((await c.fetchKitComponents({ ood: 'SAP', partNumber: 'K' })).components[0].quantity, 'abc');
});

test('recorded mode replays the raw API6 answer from kits-default.json and makes no call', async () => {
  const c = createApi6Client({ mode: 'recorded' });
  const cn = await c.fetchKitComponents({ ood: 'CN', partNumber: 'CN-K001' });
  assert.equal(cn.status, 'OK');
  assert.deepEqual(cn.components.map((x) => [x.partNumber, x.quantity]), [['CN-K001-A', 2], ['CN-K001-B', 1]]);
  const real = await c.fetchKitComponents({ ood: 'CN', partNumber: 'PQ0301400-T46NK' });
  assert.deepEqual(real.components.map((x) => [x.partNumber, x.quantity]), [['ORAR00351-N7083', 20], ['PQ0301400-T46', 10], ['QRAR04250-N7004', 10]]);
  // the same part under ANOTHER OOD is a different ERP's BOM: not there
  assert.equal((await c.fetchKitComponents({ ood: 'SAP', partNumber: 'CN-K001' })).status, 'NOT_FOUND');
});

test('the kit call uses the SAME credentials as the price call (one API6 auth strategy for every endpoint)', async () => {
  const { basicAuth } = require('../src/auth/strategies');
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, authorization: init.headers.Authorization || init.headers.authorization });
    const answer = url.endsWith('/getKitComponents') ? realAnswer : { status: { statusCode: 'SUCCESS', faultMessage: [] }, calculatedPriceList: [] };
    return { ok: true, status: 200, statusText: 'OK', json: async () => answer };
  };
  const c = createApi6Client({ mode: 'live', baseUrl: 'https://api6.example', auth: basicAuth({ username: 'svc', password: 'pw' }), fetchImpl });
  await c.fetchKitComponents({ ood: 'SAP', partNumber: 'K-1' });
  await c.fetchBiPriceList({ customer: { customerId: '1' }, item: [{ lineId: '1', itemLongNumber: 'X', salesQuantity: 1 }] });
  const expected = 'Basic ' + Buffer.from('svc:pw').toString('base64');
  assert.equal(seen.length, 2);
  assert.ok(seen.every((r) => r.authorization === expected), JSON.stringify(seen));
});
