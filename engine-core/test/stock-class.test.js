const { test } = require('node:test');
const assert = require('node:assert/strict');
const { price } = require('../src/index');
const { CONFIDENCE, PURPOSE } = require('../src/cost');

/** Stock-class raw-code normalization (OMT/SMT/MTS-Z/...) happens in srv, before engine-core
 * ever sees an item — the kernel only ever branches on the clean item.stockClass value via
 * the existing `when` mechanism (same one item.coo already uses). These tests exercise that
 * from engine-core's side only: given an already-normalized item.stockClass (or a caller-set
 * item.stockClassError when normalization failed), does the kernel do the right thing. */
const CONFIG = {
  region: 'EUROPE',
  version: '2026.08.0',
  buildUp: [
    { id: 'BASE_COST', type: 'BASE' },
    { id: 'MTS_ONLY', type: 'ADDER', amount: '10', when: "item.stockClass === 'MTS'" },
    { id: 'NONMTS_ONLY', type: 'ADDER', amount: '25', when: "item.stockClass === 'NonMTS'" },
  ],
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

test('an MTS item only picks up the MTS-conditioned element', () => {
  const line = priceItem({ stockClass: 'MTS' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '110');
  assert.equal(line.trace.stockClass, 'MTS');
});

test('a NonMTS item only picks up the NonMTS-conditioned element', () => {
  const line = priceItem({ stockClass: 'NonMTS' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '125');
  assert.equal(line.trace.stockClass, 'NonMTS');
});

test('an item with no stockClass at all skips every stockClass-conditioned element — backward compatible', () => {
  const line = priceItem({});
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '100');
  assert.equal(line.trace.stockClass, null);
});

test('item.stockClassError short-circuits to a typed MISSING before cost resolution even runs', () => {
  const line = priceItem({ stockClassError: 'STOCK_CLASS_NOT_PROVIDED' });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'STOCK_CLASS_UNRESOLVED');
  assert.equal(line.missing.detail, 'STOCK_CLASS_NOT_PROVIDED');
  assert.equal(line.trace.costCandidate, null, 'never got as far as picking a cost candidate');
});
