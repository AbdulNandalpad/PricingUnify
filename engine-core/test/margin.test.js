const { test } = require('node:test');
const assert = require('node:assert/strict');
const { price } = require('../src/index');
const { CONFIDENCE, PURPOSE } = require('../src/cost');

const CONFIG = { region: 'EUROPE', version: 't', buildUp: [{ id: 'BASE_COST', type: 'BASE' }, { id: 'MARKUP', type: 'FACTOR', rate: '0.1', basis: ['BASE_COST'] }], constraints: [], rounding: { mode: 'HALF_UP', decimalPlaces: 2 } };
const facts = { costs: { P: { default: 'C', candidates: [{ value: '80', currency: 'EUR', confidence: CONFIDENCE.EXACT, source: { key: 'C', system: 'ERP' } }] } }, elements: {} };
const run = (extra) => price({ request: { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'P', quantity: 1, ...extra }] }, facts, config: CONFIG }).items[0];

test('no margin / price given: pure landed cost, no selling price fields (unchanged)', () => {
  const l = run({});
  assert.equal(l.result.unitPrice, '88'); // 80 x 1.1
  assert.equal(l.result.sellingPrice, undefined);
  assert.equal(l.result.marginPct, undefined);
});

test('margin 20 %: selling price = landed / (1 - 0.20) = 110 on a landed cost of 88', () => {
  const l = run({ margin: { marginPct: 20 } });
  assert.equal(l.result.unitPrice, '88');
  assert.equal(l.result.sellingPrice, '110');
  assert.equal(l.result.marginPct, '20');
  assert.equal(l.result.priceBy, 'MARGIN');
});

test('manual price 100: the implied margin is (100 - 88) / 100 = 12 %', () => {
  const l = run({ manualPrice: '100' });
  assert.equal(l.result.sellingPrice, '100');
  assert.equal(l.result.marginPct, '12');
  assert.equal(l.result.priceBy, 'MANUAL');
  assert.equal(run({ manualPrice: 100, margin: { marginPct: 50 } }).result.priceBy, 'MANUAL'); // the typed price wins over a margin
});

test('margin works per price unit: landed 2.2951 -> 229.51 per 100, selling = landed / (1 - m) on that', () => {
  const cfg = { ...CONFIG, buildUp: [{ id: 'BASE_COST', type: 'BASE' }], rounding: { mode: 'HALF_UP', decimalPlaces: 2 } };
  const f = { costs: { P: { default: 'C', candidates: [{ value: '0.0219', currency: 'EUR', confidence: CONFIDENCE.EXACT, source: { key: 'C', system: 'CCD' } }] } }, elements: {} };
  const l = price({ request: { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'P', quantity: 1, priceUnit: 100, margin: { marginPct: 25 } }] }, facts: f, config: cfg }).items[0];
  assert.equal(l.result.unitPrice, '2.19');
  assert.equal(l.result.sellingPrice, '2.92'); // 2.19 / 0.75
});

test('invalid margin or manual price is a typed MISSING, never a guess', () => {
  for (const m of [-1, 100, 150, 'abc']) assert.equal(run({ margin: { marginPct: m } }).missing.reason, 'MARGIN_INVALID');
  for (const p of [0, -5, 'abc']) assert.equal(run({ manualPrice: p }).missing.reason, 'MANUAL_PRICE_INVALID');
});

test('predefined margin rules: first matching rule fires when nothing was typed; typed margin / price always wins; `in` list works', () => {
  const cfg = { ...CONFIG, marginRules: [
    { id: 'R_TSSB', when: ["item.supplier === 'S_BNG'", 'item.productCategory in PG,PH,PS'], marginPct: 90 },
    { id: 'R_OTHER', when: 'item.productCategory in PG,PH,PS', marginPct: 58 },
  ] };
  const go = (extra) => price({ request: { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'P', quantity: 1, ...extra }] }, facts, config: cfg }).items[0];
  const a = go({ supplier: 'S_BNG', productCategory: 'PH' });
  assert.equal(a.result.marginPct, '90');
  assert.equal(a.result.priceBy, 'DEFAULT_RULE');
  assert.equal(a.result.marginRule, 'R_TSSB');
  assert.equal(a.result.sellingPrice, '880'); // 88 / (1 - 0.90)
  assert.equal(go({ supplier: 'X', productCategory: 'PG' }).result.marginRule, 'R_OTHER');
  assert.equal(go({ supplier: 'X', productCategory: 'ZZ' }).result.sellingPrice, undefined); // no rule -> pure landed cost
  assert.equal(go({ supplier: 'S_BNG', productCategory: 'PH', margin: { marginPct: 20 } }).result.priceBy, 'MARGIN'); // typed margin wins
  assert.equal(go({ supplier: 'S_BNG', productCategory: 'PH', manualPrice: 100 }).result.priceBy, 'MANUAL');
});
