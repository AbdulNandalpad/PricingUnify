const { test } = require('node:test');
const assert = require('node:assert/strict');
const { price } = require('../src/index');
const { CONFIDENCE, PURPOSE } = require('../src/cost');

/** The Additional Cost flag (topic 10) is a line-level selector of which build-up elements
 * apply, resolved by srv (via a region's additionalCostMap) into item.includeMarkup/
 * includeLandedCost/includeTariff/includePick before engine-core sees the item — same pattern
 * as item.stockClass. `when` clauses read those with `!== false` so an item that never sets
 * additionalCost at all (the vast majority of lines) keeps pricing exactly as it always has:
 * unset is not "explicitly excluded", so every element still applies. */
const CONFIG = {
  region: 'EUROPE',
  version: '2026.08.0',
  buildUp: [
    { id: 'BASE_COST', type: 'BASE' },
    { id: 'MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: '0.10', when: 'item.includeMarkup !== false' },
    { id: 'FREIGHT', type: 'ADDER', amount: '5', when: 'item.includeLandedCost !== false' },
    { id: 'TARIFF', type: 'ADDER', amount: '2', when: 'item.includeTariff !== false' },
    { id: 'PICK', type: 'PER_LINE', amount: '10', when: 'item.includePick !== false' },
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

test('an item that never sets additionalCost prices with every element applied, unchanged', () => {
  const line = priceItem({});
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '127'); // 100 + 10(markup) + 5(freight) + 2(tariff) + 10(pick)
});

test('includeMarkup/includeLandedCost/etc explicitly false exclude their element; explicitly true (or absent) includes it', () => {
  const nothingLine = priceItem({ includeMarkup: false, includeLandedCost: false, includeTariff: false, includePick: false });
  assert.equal(nothingLine.result.unitPrice, '100'); // base cost only -- option "0 - Nothing to add"

  const markupOnly = priceItem({ includeMarkup: true, includeLandedCost: false, includeTariff: false, includePick: false });
  assert.equal(markupOnly.result.unitPrice, '110'); // option "2 - Markup only"

  const noTariff = priceItem({ includeMarkup: true, includeLandedCost: true, includeTariff: false, includePick: true });
  assert.equal(noTariff.result.unitPrice, '125'); // option "4 - Landed cost & Markup, No tariff": 100+10+5+10
});

test('item.additionalCostError short-circuits to a typed MISSING before cost resolution runs', () => {
  const line = priceItem({ additionalCostError: 'ADDITIONAL_COST_UNMAPPED:9' });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'ADDITIONAL_COST_UNRESOLVED');
  assert.equal(line.missing.detail, 'ADDITIONAL_COST_UNMAPPED:9');
  assert.equal(line.trace.costCandidate, null);
});
