const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createC4cClient } = require('../lib/c4c-client');

/** Unit tests against a fake fetch — the real C4C never exists in this sandbox, and the
 *  adapter's whole contract (typed NOT_CONFIGURED, CSRF + ETag mechanics, 412 -> typed
 *  conflict, OPPORTUNITY-never-writes-price) is testable without it. */

const DEST = { name: 'C4C_ODATA', url: 'https://my-c4c.example', username: 'tech-user', password: 'secret' };

function jsonRes(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    json: async () => body,
  };
}

/** A fake C4C: one quote Q-1 with items EU-T100 and P-10023, recording every request. */
function fakeC4c({ patchStatus = 204 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'GET' && init.headers['x-csrf-token'] === 'fetch') {
      return jsonRes({}, { headers: { 'x-csrf-token': 'csrf-123' } });
    }
    if (init.method === 'GET' && url.includes('SalesQuoteCollection') || (init.method === 'GET' && url.includes('OpportunityCollection'))) {
      return jsonRes({ d: { results: [{ ObjectID: 'HDR-OBJ-1', __metadata: { etag: 'W/"hdr-1"' } }] } });
    }
    if (init.method === 'GET' && (url.includes('SalesQuoteItemCollection') || url.includes('OpportunityItemCollection'))) {
      return jsonRes({ d: { results: [
        { ObjectID: 'ITM-1', ProductID: 'EU-T100', __metadata: { etag: 'W/"itm-1"' } },
        { ObjectID: 'ITM-2', ProductID: 'P-10023', __metadata: { etag: 'W/"itm-2"' } },
      ] } });
    }
    if (init.method === 'PATCH') {
      return jsonRes({}, { status: patchStatus });
    }
    throw new Error('unexpected call: ' + init.method + ' ' + url);
  };
  return { calls, fetchImpl };
}

test('no destination configured -> typed C4C_NOT_CONFIGURED, nothing attempted', async () => {
  const client = createC4cClient({ resolveDestination: () => null, fetchImpl: () => { throw new Error('must not be called'); } });
  const res = await client.writeBack({ objectType: 'QUOTE', objectId: 'Q-1', items: [{ partNumber: 'EU-T100' }], user: 'alice' });
  assert.equal(res.status, 'C4C_NOT_CONFIGURED');
  assert.match(res.message, /C4C_ODATA/);
});

test('QUOTE write-back: ETag-guarded item PATCHes with the mapped fields, then the header audit flags', async () => {
  const c4c = fakeC4c();
  const fixedNow = new Date('2026-11-24T10:00:00Z');
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl: c4c.fetchImpl, now: () => fixedNow });

  const res = await client.writeBack({
    objectType: 'QUOTE', objectId: 'Q-1', user: 'alice',
    items: [{ partNumber: 'EU-T100', cost: '100.00', landedCost: '130.78', price: '130.78', marginPct: '23.5 %', pricingType: 'COST_PLUS' }],
  });
  assert.equal(res.status, 'OK');
  assert.equal(res.written, 1);

  const itemPatch = c4c.calls.find((c) => c.method === 'PATCH' && c.url.includes("SalesQuoteItemCollection('ITM-1')"));
  assert.ok(itemPatch, 'item ITM-1 was patched');
  assert.equal(itemPatch.headers['If-Match'], 'W/"itm-1"'); // never a blind overwrite
  assert.equal(itemPatch.headers['x-csrf-token'], 'csrf-123');
  assert.equal(itemPatch.body.Price_SDK, '130.78');
  assert.equal(itemPatch.body.LandedCost_SDK, '130.78');
  assert.equal(itemPatch.body.Cost_SDK, '100.00');
  assert.equal(itemPatch.body.PricingType_SDK, 'COST_PLUS');

  const headerPatch = c4c.calls.find((c) => c.method === 'PATCH' && c.url.includes("SalesQuoteCollection('HDR-OBJ-1')"));
  assert.ok(headerPatch, 'header audit flags were written');
  assert.equal(headerPatch.body.ExternallyPriced_SDK, true);
  assert.equal(headerPatch.body.PricedBy_SDK, 'alice'); // always the logged-in user
  assert.equal(headerPatch.body.PricedOn_SDK, fixedNow.toISOString());
});

test('OPPORTUNITY write-back NEVER writes a price or margin, whatever the caller sends', async () => {
  const c4c = fakeC4c();
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl: c4c.fetchImpl });

  const res = await client.writeBack({
    objectType: 'OPPORTUNITY', objectId: 'O-9', user: 'bob',
    items: [{ partNumber: 'EU-T100', cost: '100.00', landedCost: '130.78', price: '130.78', marginPct: '23.5 %', pricingType: 'COST_PLUS' }],
  });
  assert.equal(res.status, 'OK');

  const itemPatch = c4c.calls.find((c) => c.method === 'PATCH' && c.url.includes('OpportunityItemCollection'));
  assert.ok(itemPatch);
  assert.equal(itemPatch.body.Price_SDK, undefined);
  assert.equal(itemPatch.body.MarginPercent_SDK, undefined);
  assert.equal(itemPatch.body.LandedCost_SDK, '130.78'); // cost fields still go
  const headerPatch = c4c.calls.find((c) => c.method === 'PATCH' && c.url.includes('OpportunityCollection('));
  assert.equal(headerPatch.body.ExternallyPriced_SDK, true); // audit flags on both object types
});

test('a 412 on an item PATCH is the typed conflict outcome, naming the part', async () => {
  const c4c = fakeC4c({ patchStatus: 412 });
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl: c4c.fetchImpl });
  const res = await client.writeBack({
    objectType: 'QUOTE', objectId: 'Q-1', user: 'alice',
    items: [{ partNumber: 'EU-T100', landedCost: '130.78' }],
  });
  assert.equal(res.status, 'C4C_CONFLICT');
  assert.equal(res.message, 'Object changed in C4C, reload.');
  assert.deepEqual(res.partNumbers, ['EU-T100']);
});

test('a product that is not an item of the C4C object is a typed error, not a silent skip', async () => {
  const c4c = fakeC4c();
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl: c4c.fetchImpl });
  const res = await client.writeBack({
    objectType: 'QUOTE', objectId: 'Q-1', user: 'alice',
    items: [{ partNumber: 'NOT-ON-QUOTE', landedCost: '1.00' }],
  });
  assert.equal(res.status, 'C4C_ERROR');
  assert.match(res.message, /NOT-ON-QUOTE/);
});

test('the field map is configuration: an override changes what gets written, not the code', async () => {
  const c4c = fakeC4c();
  const client = createC4cClient({
    resolveDestination: () => DEST,
    fetchImpl: c4c.fetchImpl,
    fieldMap: { price: 'zNetPrice', landedCost: 'zLandedCost' },
  });
  await client.writeBack({
    objectType: 'QUOTE', objectId: 'Q-1', user: 'alice',
    items: [{ partNumber: 'EU-T100', landedCost: '130.78', price: '130.78' }],
  });
  const itemPatch = c4c.calls.find((c) => c.method === 'PATCH' && c.url.includes('SalesQuoteItemCollection'));
  assert.equal(itemPatch.body.zNetPrice, '130.78');
  assert.equal(itemPatch.body.zLandedCost, '130.78');
  assert.equal(itemPatch.body.Price_SDK, undefined);
});
