const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApi6Client } = require('../src');

/** KIT component fetch: one independent endpoint PER ORIGIN OF DATA (each ERP serves its own BOMs). */

const okAnswer = { components: [{ partNumber: 'C-1', quantity: 2, uom: 'PC' }, { partNumber: 'C-2', quantity: 1 }, { partNumber: '', quantity: 5 }] };
const fakeFetch = (calls, answer = okAnswer, ok = true) => async (url, init) => {
  calls.push({ url, method: init.method, body: JSON.parse(init.body) });
  return { ok, status: ok ? 200 : 503, statusText: ok ? 'OK' : 'Service Unavailable', json: async () => answer };
};

test('live: POSTs { ood, partNumber } to THAT OOD\'s configured endpoint; unnamed components are dropped, never invented', async () => {
  const calls = [];
  const c = createApi6Client({ mode: 'live', baseUrl: 'https://api6.example', kitEndpoints: { SMA: '/kits/jde-e1', SAP: '/erp/sap/boms' }, fetchImpl: fakeFetch(calls) });

  const sma = await c.fetchKitComponents({ ood: 'SMA', partNumber: 'K-1' });
  assert.equal(calls[0].url, 'https://api6.example/kits/jde-e1');
  assert.deepEqual(calls[0].body, { ood: 'SMA', partNumber: 'K-1' });
  assert.equal(sma.status, 'OK');
  assert.deepEqual(sma.components.map((x) => [x.partNumber, x.quantity]), [['C-1', 2], ['C-2', 1]]);

  await c.fetchKitComponents({ ood: 'SAP', partNumber: 'K-2' });
  assert.equal(calls[1].url, 'https://api6.example/erp/sap/boms', 'each OOD is routed independently');
});

test('an OOD with no configured endpoint falls back to /kits/<ood lowercased>', async () => {
  const calls = [];
  const c = createApi6Client({ mode: 'live', baseUrl: 'https://api6.example', fetchImpl: fakeFetch(calls) });
  const res = await c.fetchKitComponents({ ood: 'CN', partNumber: 'K-1' });
  assert.equal(calls[0].url, 'https://api6.example/kits/cn');
  assert.equal(res.endpoint, '/kits/cn');
});

test('a gateway fault is { status: FAILED, message }, never a throw; an empty answer is NOT_FOUND', async () => {
  const down = createApi6Client({ mode: 'live', baseUrl: 'https://x', fetchImpl: fakeFetch([], {}, false) });
  const failed = await down.fetchKitComponents({ ood: 'SAP', partNumber: 'K' });
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.message, /503/);
  assert.deepEqual(failed.components, []);

  const empty = createApi6Client({ mode: 'live', baseUrl: 'https://x', fetchImpl: fakeFetch([], { components: [] }) });
  const none = await empty.fetchKitComponents({ ood: 'SAP', partNumber: 'K' });
  assert.equal(none.status, 'NOT_FOUND');
});

test('recorded mode simulates the per-OOD endpoint from kits-default.json and makes no call', async () => {
  const c = createApi6Client({ mode: 'recorded' });
  const cn = await c.fetchKitComponents({ ood: 'CN', partNumber: 'CN-K001' });
  assert.equal(cn.status, 'OK');
  assert.deepEqual(cn.components.map((x) => [x.partNumber, x.quantity]), [['CN-K001-A', 2], ['CN-K001-B', 1]]);
  // the same part under ANOTHER OOD is a different ERP's BOM: not there
  assert.equal((await c.fetchKitComponents({ ood: 'SAP', partNumber: 'CN-K001' })).status, 'NOT_FOUND');
});
