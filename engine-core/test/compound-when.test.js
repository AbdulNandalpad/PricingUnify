const { test } = require('node:test');
const assert = require('node:assert/strict');
const { price } = require('../src/index');
const { CONFIDENCE, PURPOSE } = require('../src/cost');

/** China's real logic branches on more than one field at once (origin of data AND supplier
 * AND COO) — a single "path OP literal" `when` can't express that, so `when` also accepts an
 * array of expressions, AND-ed together. This mirrors the shape China's own reference docs
 * describe: a COO-conditioned freight&duty FACTOR (composite, allocatable:false per
 * requirements §5.1) feeds a later markup FACTOR, which must stay safe even though only one
 * of the two mutually-exclusive COO branches ever actually fires for a given item. */
const CONFIG = {
  region: 'CHINA',
  version: '2026.08.0',
  buildUp: [
    { id: 'BASE_COST', type: 'BASE' },
    { id: 'FD_US', type: 'FACTOR', basis: ['BASE_COST'], rate: '0.32', composite: true, allocatable: false, when: ["item.ood !== 'CN'", "item.coo === 'US'"] },
    { id: 'FD_NONUS', type: 'FACTOR', basis: ['BASE_COST'], rate: '0.21', composite: true, allocatable: false, when: ["item.ood !== 'CN'", "item.coo !== 'US'"] },
    { id: 'MARKUP', type: 'FACTOR', basis: ['BASE_COST', 'FD_US', 'FD_NONUS'], rate: '0.032', when: "item.ood !== 'CN'" },
  ],
  constraints: [],
  rounding: { mode: 'HALF_UP', decimalPlaces: 4 },
};

function priceItem(itemOverrides) {
  const request = { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'P-1', quantity: 1, ...itemOverrides }] };
  const facts = {
    costs: { 'P-1': { default: 'C', candidates: [{ value: '100.00', currency: 'CNY', confidence: CONFIDENCE.EXACT, source: { key: 'C' } }] } },
    elements: {},
  };
  return price({ request, facts, config: CONFIG }).items[0];
}

test('a compound `when` (array) only matches when every condition is true', () => {
  const usLine = priceItem({ ood: 'SAP', coo: 'US' });
  assert.equal(usLine.status, 'PRICED');
  assert.equal(usLine.result.unitPrice, '136.224'); // 100 * 1.32 * 1.032

  const nonUsLine = priceItem({ ood: 'SAP', coo: 'IT' });
  assert.equal(nonUsLine.status, 'PRICED');
  assert.equal(nonUsLine.result.unitPrice, '124.872'); // 100 * 1.21 * 1.032
});

test('a `when`-skipped element contributes zero to a later FACTOR basis instead of crashing', () => {
  // MARKUP's basis lists both FD_US and FD_NONUS, but only one ever actually fires — the other
  // must resolve to 0, not throw "FACTOR basis references unknown step".
  const line = priceItem({ ood: 'SAP', coo: 'US' });
  assert.equal(line.status, 'PRICED');
});

test('when ood === CN, every ood-conditioned element is skipped and the running total is untouched', () => {
  const line = priceItem({ ood: 'CN', coo: 'US' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '100'); // no FD/MARKUP factor applies at all
});

test('a skipped element still shows up in the trace, so a BINDING caller can see why a branch did not apply', () => {
  const line = priceItem({ ood: 'CN', coo: 'US' });
  const skipped = line.trace.steps.filter((s) => s.note && s.note.skipped);
  assert.equal(skipped.length, 3); // FD_US, FD_NONUS, MARKUP all skipped
  assert.ok(skipped.every((s) => s.delta === '0'));
});
