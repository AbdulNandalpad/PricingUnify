const { test } = require('node:test');
const assert = require('node:assert/strict');
const { price } = require('../src/index');
const { CONFIDENCE, PURPOSE } = require('../src/cost');

/** Supported pricing types are COST_PLUS and PRICE_LIST only (owner decision 2026-11-24).
 * The kernel itself has no pricing-type branching — PRICE_LIST only changes which cost
 * candidate arrives, selected upstream in srv. What the kernel DOES own is the two typed
 * MISSING short-circuits: a caller-flagged unsupported type (item.pricingTypeError) and a
 * caller-flagged price-list lookup miss (item.priceListError) — same resolved-before-the-
 * kernel pattern as stockClassError/additionalCostError, never a silent fall-back. */
const CONFIG = {
  region: 'EUROPE',
  version: '2026.11.0',
  buildUp: [{ id: 'BASE_COST', type: 'BASE' }],
  constraints: [],
  rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
};

function priceItem(itemOverrides) {
  const request = { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'P-1', quantity: 1, ...itemOverrides }] };
  const facts = {
    costs: { 'P-1': { default: 'C', candidates: [{ value: '100.00', currency: 'EUR', confidence: CONFIDENCE.EXACT, source: { key: 'C' } }] } },
    elements: {},
  };
  return price({ request, facts, config: CONFIG }).items[0];
}

test('item.pricingTypeError short-circuits to a typed MISSING before cost resolution runs', () => {
  const line = priceItem({ pricingTypeError: 'PRICING_TYPE_UNSUPPORTED:VARIANT (supported: COST_PLUS, PRICE_LIST)' });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'PRICING_TYPE_UNSUPPORTED');
  assert.match(line.missing.detail, /VARIANT/);
  assert.equal(line.trace.costCandidate, null); // never got as far as picking a cost
});

test('item.priceListError short-circuits to a typed MISSING naming what was tried', () => {
  const line = priceItem({ pricingType: 'PRICE_LIST', priceListError: 'TRIED:SUPPLIER:GLOBEX' });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'PRICE_LIST_COST_NOT_FOUND');
  assert.equal(line.missing.detail, 'TRIED:SUPPLIER:GLOBEX');
});

test('a clean item is untouched by the pricing-type short-circuits', () => {
  const line = priceItem({ pricingType: 'COST_PLUS' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '100');
});
