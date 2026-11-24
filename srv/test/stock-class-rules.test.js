'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { store } = require('../lib/store');
const { seed } = require('../lib/seed');
const { stockClassRulesForOod, stockClassFromPicked } = require('../lib/origin-of-data');

seed();
const TODAY = '2026-11-24';

test('the stock-class rule belongs to the part\'s Origin of Data: SAP-sourced parts get the Europe rule whichever region is pricing (China / Americas / India buying from Europe)', () => {
  const europe = store.getEffectiveAsOf('EUROPE', '*', TODAY).stockClassRules;
  assert.deepEqual(europe.rules, [{ ood: 'SAP', strategyCode: 'Z4', stockClass: 'MTS' }]);

  for (const pricingRegion of ['CHINA', 'AMERICAS', 'INDIA', 'EUROPE']) {
    const pricingRules = store.getEffectiveAsOf(pricingRegion, '*', TODAY).stockClassRules || null;
    const rules = stockClassRulesForOod({ store, ood: 'SAP', pricingRules, date: TODAY });
    assert.deepEqual(rules, europe, `${pricingRegion} quote, SAP-sourced part`);
    const z4 = stockClassFromPicked({ stockClassWarehouse: '1020', strategyGroupCode: 'Z4' }, null, { rules, ood: 'SAP' });
    const z8 = stockClassFromPicked({ stockClassWarehouse: '1020', strategyGroupCode: 'Z8' }, null, { rules, ood: 'SAP' });
    assert.equal(z4.stockClass, 'MTS', `${pricingRegion}: SAP + Z4`);
    assert.equal(z8.stockClass, 'NonMTS', `${pricingRegion}: SAP + Z8`);
  }
});

test('a part from another Origin of Data uses its own region\'s rules, else the pricing region\'s (none configured today -> null)', () => {
  assert.equal(stockClassRulesForOod({ store, ood: 'CN', pricingRules: null, date: TODAY }), null);
  const fallback = { rules: [], default: 'NonMTS' };
  assert.equal(stockClassRulesForOod({ store, ood: 'CN', pricingRules: fallback, date: TODAY }), fallback);
  assert.equal(stockClassRulesForOod({ store, ood: '', pricingRules: fallback, date: TODAY }), fallback);
});

test('Europe pricing a part from ANOTHER origin (China, India, SMA) is not touched by the SAP golden rule — no default NonMTS leaks onto it', () => {
  const europe = store.getEffectiveAsOf('EUROPE', '*', TODAY).stockClassRules;
  for (const ood of ['CN', 'IN', 'SMA']) {
    const rules = stockClassRulesForOod({ store, ood, pricingRules: europe, date: TODAY }); // falls back to Europe's set
    const r = stockClassFromPicked({ stockClassWarehouse: 'W1', strategyGroupCode: 'Z8', stockClassRaw: 'MTS' }, { MTS: 'MTS' }, { rules, ood });
    assert.equal(r.stockClass, undefined, `${ood}: no class from the SAP rule`);
    assert.match(r.note, /^STRATEGY_GROUP_RULE_PENDING:Z8/, `${ood}: typed pending note instead`);
  }
});
