const { test } = require('node:test');
const assert = require('node:assert/strict');
const { price } = require('../src/index');
const { CONFIDENCE, PURPOSE } = require('../src/cost');

const CONFIG = {
  region: 'EUROPE',
  version: '2026.08.0',
  buildUp: [{ id: 'BASE_COST', type: 'BASE' }],
  constraints: [{ id: 'MOQ', type: 'CONSTRAINT', kind: 'MIN_QTY', minRef: 'moq' }],
  rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
};

function priceQty(quantity, moq) {
  const request = { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'P-1', quantity }] };
  const facts = {
    costs: { 'P-1': { default: 'C', candidates: [{ value: '10.00', currency: 'EUR', confidence: CONFIDENCE.EXACT, source: { key: 'C' } }] } },
    elements: { 'P-1': { moq } },
  };
  return price({ request, facts, config: CONFIG }).items[0];
}

test('MIN_QTY does not change the price when quantity meets the minimum', () => {
  const line = priceQty(50, '50');
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '10');
  assert.equal(line.trace.constraintPasses.length, 0);
});

test('MIN_QTY is informational only — flags a below-minimum order without changing the price', () => {
  const line = priceQty(5, '50');
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '10', 'MOQ never silently adjusts price — same precedent as MROQ being routing input, not a constraint');
  assert.equal(line.trace.constraintPasses.length, 1);
  assert.equal(line.trace.constraintPasses[0].kind, 'MIN_QTY');
  assert.equal(line.trace.constraintPasses[0].quantity, '5');
  assert.equal(line.trace.constraintPasses[0].min, '50');
});

test('MIN_QTY is silently absent from the trace when no moq fact is configured', () => {
  const line = priceQty(1, undefined);
  assert.equal(line.trace.constraintPasses.length, 0);
});
