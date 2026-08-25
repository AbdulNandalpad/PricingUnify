const { test } = require('node:test');
const assert = require('node:assert/strict');
const { price } = require('../src/index');
const { CONFIDENCE, PURPOSE } = require('../src/cost');

/** MOLV's real mechanism genuinely differs across TSS regions/sheets: some correct the unit
 * price at the existing quantity (the original FLOOR behavior), others correct the order
 * quantity at the existing unit price (topic 5's finding — the newest China sheet, with a
 * stakeholder correction comment, says "Quantity = MOLV/Unit sell price"). Per the owner:
 * this is a config decision, not a universal rule — `mode` lives on the CONSTRAINT element. */
const CONFIG_QTY_MODE = {
  region: 'CHINA',
  version: '2026.08.0',
  buildUp: [{ id: 'BASE_COST', type: 'BASE' }],
  constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv', mode: 'QUANTITY' }],
  rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
};

function priceQty(quantity, molv) {
  const request = { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'P-1', quantity }] };
  const facts = {
    costs: { 'P-1': { default: 'C', candidates: [{ value: '103.20', currency: 'CNY', confidence: CONFIDENCE.EXACT, source: { key: 'C' } }] } },
    elements: { 'P-1': { molv } },
  };
  return price({ request, facts, config: CONFIG_QTY_MODE }).items[0];
}

test('QUANTITY mode leaves the unit price untouched and bumps the order quantity instead', () => {
  const line = priceQty(1, '500.00');
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '103.2'); // unchanged, unlike PRICE mode
  assert.equal(line.result.quantity, 5); // ceil(500 / 103.2) = ceil(4.844..) = 5
  assert.equal(line.trace.constraintPasses.length, 1);
  assert.equal(line.trace.constraintPasses[0].mode, 'QUANTITY');
  assert.equal(line.trace.constraintPasses[0].quantityFrom, '1');
  assert.equal(line.trace.constraintPasses[0].quantityTo, '5');
});

test('QUANTITY mode does not fire when the line already meets MOLV at the requested quantity', () => {
  const line = priceQty(10, '500.00'); // 103.2 * 10 = 1032 >= 500
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '103.2');
  assert.equal(line.result.quantity, 10);
  assert.equal(line.trace.constraintPasses.length, 0);
});

test('a later MIN_QTY constraint in the same pass sees the quantity a QUANTITY-mode FLOOR already bumped', () => {
  const config = {
    ...CONFIG_QTY_MODE,
    constraints: [
      { id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv', mode: 'QUANTITY' },
      { id: 'MOQ', type: 'CONSTRAINT', kind: 'MIN_QTY', min: 5 },
    ],
  };
  const request = { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'P-1', quantity: 1 }] };
  const facts = {
    costs: { 'P-1': { default: 'C', candidates: [{ value: '103.20', currency: 'CNY', confidence: CONFIDENCE.EXACT, source: { key: 'C' } }] } },
    elements: { 'P-1': { molv: '500.00' } },
  };
  const line = price({ request, facts, config }).items[0];
  // MOLV bumps quantity 1 -> 5, which already meets MOQ's minimum of 5 -- MOQ should not fire.
  assert.equal(line.result.quantity, 5);
  assert.equal(line.trace.constraintPasses.length, 1);
});

test('PRICE mode (the default, unset) keeps adjusting price, not quantity -- existing behavior is unchanged', () => {
  const config = { ...CONFIG_QTY_MODE, constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv' }] };
  const request = { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'P-1', quantity: 1 }] };
  const facts = {
    costs: { 'P-1': { default: 'C', candidates: [{ value: '103.20', currency: 'CNY', confidence: CONFIDENCE.EXACT, source: { key: 'C' } }] } },
    elements: { 'P-1': { molv: '500.00' } },
  };
  const line = price({ request, facts, config }).items[0];
  assert.equal(line.result.unitPrice, '500'); // 500 / qty(1)
  assert.equal(line.result.quantity, 1); // untouched
  assert.equal(line.trace.constraintPasses[0].mode, 'PRICE');
});
