const { test } = require('node:test');
const assert = require('node:assert/strict');
const { price } = require('../src/index');
const { CONFIDENCE, PURPOSE } = require('../src/cost');

/**
 * Parity with a REAL response of the BI price service (WSO2 getCustomerPriceList, quote
 * 235616, part OR1600810-V9005, Europe, MTO, supplier X_SIL, Additional Cost flag 1). Its own
 * explanation reads:
 *   ".0318 EUR (Unit Cost) x 30000 (Qty) x 1.048 (SCM Markup) x 1.01 (Landed Cost Factor)
 *    + 6% (Anticipated Cost Increase) + 21 EUR (Pick Charge)"
 * and it answered costPlusUnitAmt 0.0364 / 0.0291 / 0.0456 for the three lines. This proves
 * the five primitives express that arithmetic (order: markup -> landed-cost factor ->
 * anticipated cost increase on the running total -> per-order pick divided by qty) with
 * config only. The rates below are THE SERVICE'S numbers for that sample (SCM 4.8 %, landed
 * 1 %, anticipated increase 6 %, pick 21 EUR) — NOT a statement about the seeded EUROPE
 * config, which still carries 4.7 % and no anticipated-cost-increase step (owner decision
 * pending; see CLAUDE.md).
 */
const CONFIG = {
  region: 'EUROPE',
  version: 'bi-sample',
  buildUp: [
    { id: 'BASE_COST', type: 'BASE' },
    { id: 'SCM_MARKUP', type: 'FACTOR', rate: '0.048', basis: ['BASE_COST'] },
    { id: 'LANDED_COST', type: 'FACTOR', rate: '0.01', basis: ['BASE_COST', 'SCM_MARKUP'] },
    { id: 'ANTICIPATED_COST_INCREASE', type: 'FACTOR', rate: '0.06', basis: ['BASE_COST', 'SCM_MARKUP', 'LANDED_COST'] },
    { id: 'PICK', type: 'PER_LINE', amount: '21' },
  ],
  constraints: [],
  rounding: { mode: 'HALF_UP', decimalPlaces: 4 },
};

function landedUnitCost(partCost, quantity) {
  const request = { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'OR1600810-V9005', quantity }] };
  const facts = {
    costs: { 'OR1600810-V9005': { default: 'C', candidates: [{ value: partCost, currency: 'EUR', confidence: CONFIDENCE.EXACT, source: { key: 'C', system: 'C4C' } }] } },
    elements: {},
  };
  const line = price({ request, facts, config: CONFIG }).items[0];
  assert.equal(line.status, 'PRICED');
  return line.result.unitPrice;
}

test('the three real BI lines: cost .0318 / .0253 @ 30000 and CCD cost .0219 @ 1000', () => {
  assert.equal(landedUnitCost('0.0318', 30000), '0.0364');
  assert.equal(landedUnitCost('0.0253', 30000), '0.0291');
  assert.equal(landedUnitCost('0.0219', 1000), '0.0456');
});
