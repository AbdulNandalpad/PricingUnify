const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApi6Client, apiKeyAuth } = require('../src/index');

test('defaults to recorded mode with no auth required', async () => {
  const client = createApi6Client();
  assert.equal(client.mode, 'recorded');
  assert.equal(client.authType, 'NONE');
});

test('getPricingFacts replays the region-shaped recorded fixture', async () => {
  const client = createApi6Client();
  const facts = await client.getPricingFacts({ region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-10023', quantity: 10 }] });

  assert.ok(facts.costs['P-10023']);
  assert.equal(facts.costs['P-10023'].candidates[0].value, '100.00');
  assert.equal(facts.elements['P-10023'].freight, '0.05'); // freight is a RATE (5%), not an amount -- owner correction 2026-08-26
});

test('live mode is configurable with a real auth strategy without needing a network call to construct it', () => {
  const client = createApi6Client({ mode: 'live', baseUrl: 'https://api6.example', auth: apiKeyAuth({ apiKey: 'k' }) });
  assert.equal(client.mode, 'live');
  assert.equal(client.authType, 'API_KEY');
});

test('fetchCostsBySequence walks the sequence calling per-source endpoints and stops at the first hit', async () => {
  const client = createApi6Client();
  // P-50099 only has CCD and CCP candidates -- the walk must try (and record) C4C and ERP first.
  const { candidates, routing } = await client.fetchCostsBySequence({
    region: 'EUROPE', salesOrg: '*', partNumber: 'P-50099', quantity: 5,
    sequence: ['C4C', 'ERP', 'CCD', 'CCP'],
  });
  assert.deepEqual(routing, [
    { system: 'C4C', endpoint: '/costs/c4c', found: 0 },
    { system: 'ERP', endpoint: '/costs/erp', found: 0 },
    { system: 'CCD', endpoint: '/costs/ccd', found: 1 },
  ]); // stopped at CCD -- CCP was never called
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source.system, 'CCD');
});

test('fetchPriceListCost matches the supplier price list, picking the quantity-break tier', async () => {
  const client = createApi6Client();
  const res = await client.fetchPriceListCost({
    region: 'EUROPE', partNumber: 'EU-T100', supplier: 'ACME', quantity: 60, priceDate: '2026-11-24',
  });
  assert.equal(res.matchedBy, 'SUPPLIER:ACME');
  assert.equal(res.entry.value, '85.00'); // qty 60 lands on the minQty-50 tier, not minQty-1
});

test('fetchPriceListCost falls back from supplier to product category, and a full miss lists every key tried', async () => {
  const client = createApi6Client();
  const viaCategory = await client.fetchPriceListCost({
    region: 'EUROPE', partNumber: 'P-10023', productCategory: 'SEALS', quantity: 1, priceDate: '2026-11-24',
  });
  assert.equal(viaCategory.matchedBy, 'CATEGORY:SEALS');
  assert.equal(viaCategory.entry.value, '80.00');

  const miss = await client.fetchPriceListCost({
    region: 'EUROPE', partNumber: 'P-20045', supplier: 'GLOBEX', productCategory: 'SEALS', quantity: 1, priceDate: '2026-11-24',
  });
  assert.equal(miss.entry, null);
  assert.deepEqual(miss.tried, ['SUPPLIER:GLOBEX', 'CATEGORY:SEALS']);
});

test('fetchPriceListCost honors effective dating against the price date', async () => {
  const client = createApi6Client();
  // Every seeded entry is validFrom 2026-01-01 -- a 2025 price date must find nothing.
  const res = await client.fetchPriceListCost({
    region: 'EUROPE', partNumber: 'EU-T100', supplier: 'ACME', quantity: 10, priceDate: '2025-06-01',
  });
  assert.equal(res.entry, null);
});
