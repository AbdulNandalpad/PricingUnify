const { test } = require('node:test');
const assert = require('node:assert/strict');
const { price } = require('../src/index');
const { CONFIDENCE, PURPOSE } = require('../src/cost');

// A cents-level part (the real BI sample: cost .0219 EUR per piece) with a markup, rounded to
// 2 decimals — exactly where rounding per piece first would destroy the number.
const CONFIG = {
  region: 'EUROPE', version: 't',
  buildUp: [
    { id: 'BASE_COST', type: 'BASE' },
    { id: 'SCM_MARKUP', type: 'FACTOR', rate: '0.048', basis: ['BASE_COST'] },
  ],
  constraints: [],
  rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
};
const facts = { costs: { P: { default: 'C', candidates: [{ value: '0.0219', currency: 'EUR', confidence: CONFIDENCE.EXACT, source: { key: 'C', system: 'CCD' } }] } }, elements: {} };
const run = (extra) => price({ request: { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'P', quantity: 1, ...extra }] }, facts, config: CONFIG }).items[0];

test('without a price unit a cents-level part rounds to 0.02 per piece (unchanged behaviour)', () => {
  const l = run({});
  assert.equal(l.result.unitPrice, '0.02');
  assert.equal(l.result.priceUnit, undefined);
});

test('price unit 100: computed per piece at full precision, scaled, THEN rounded -> 2.3 per 100', () => {
  const l = run({ priceUnit: 100 });
  assert.equal(l.status, 'PRICED');
  assert.equal(l.result.unitPrice, '2.3'); // 0.0219 x 1.048 x 100 = 2.29512 -> 2.30
  assert.equal(l.result.priceUnit, '100');
  assert.equal(run({ priceUnit: '100.00000000000000' }).result.unitPrice, '2.3'); // C4C's own spelling
});

test('an invalid price unit is a typed MISSING, never a guess', () => {
  for (const bad of [0, -5, 'abc']) {
    const l = run({ priceUnit: bad });
    assert.equal(l.status, 'MISSING');
    assert.equal(l.missing.reason, 'PRICE_UNIT_INVALID');
  }
});
