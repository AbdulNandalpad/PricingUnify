'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { store } = require('../lib/store');
const { seed } = require('../lib/seed');
const { stockClassRulesForOod, stockClassFromPicked, defaultWarehouseForOod } = require('../lib/origin-of-data');

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
    assert.equal(r.stockClassBy, undefined, `${ood}: not decided by the SAP rule`);
    assert.equal(r.stockClass, 'MTS', `${ood}: keeps its own raw class (MTS), no SAP default NonMTS leaks onto it`);
  }
});

test('the default warehouse (1020) belongs to the part\'s Origin of Data too: a SAP-sourced part gets it in every pricing region; other origins have none configured', () => {
  assert.equal(store.getEffectiveAsOf('EUROPE', '*', TODAY).defaultWarehouse, '1020');
  for (const pricingRegion of ['CHINA', 'AMERICAS', 'INDIA', 'EUROPE']) {
    const pricingDefault = store.getEffectiveAsOf(pricingRegion, '*', TODAY).defaultWarehouse || null;
    assert.equal(defaultWarehouseForOod({ store, ood: 'SAP', pricingDefault, date: TODAY }), '1020', pricingRegion);
  }
  // Owner rule 2026-11-25: no preferred warehouse -> SMA LG01, CN CNSHS1, IN LCI (each from the region that owns that origin)
  assert.equal(defaultWarehouseForOod({ store, ood: 'SMA', pricingDefault: null, date: TODAY }), 'LG01');
  assert.equal(defaultWarehouseForOod({ store, ood: 'CN', pricingDefault: null, date: TODAY }), 'CNSHS1');
  assert.equal(defaultWarehouseForOod({ store, ood: 'IN', pricingDefault: null, date: TODAY }), 'LCI');
  // ...and the origin decides, not the quote's region: an AMERICAS quote with a CN-origin part gets CNSHS1
  assert.equal(defaultWarehouseForOod({ store, ood: 'CN', pricingDefault: 'LG01', date: TODAY }), 'CNSHS1');
});

test('INDIA has a stock-class map (C4C raw MTS / MTO / MTC), so an India-origin part with strategy group 1 / 0 resolves from its raw class', () => {
  const india = store.getEffectiveAsOf('INDIA', '*', TODAY);
  assert.equal(india.stockClassMap.MTO, 'NonMTS');
  const rules = stockClassRulesForOod({ store, ood: 'IN', pricingRules: null, date: TODAY });
  const r1 = stockClassFromPicked({ stockClassWarehouse: 'LCI', strategyGroupCode: '1', strategyGroupDesc: 'MTS1', stockClassRaw: 'MTS' }, india.stockClassMap, { rules, ood: 'IN' });
  assert.deepEqual(r1, { stockClass: 'MTS' });
  const r0 = stockClassFromPicked({ stockClassWarehouse: 'LCI', strategyGroupCode: '0', strategyGroupDesc: 'MTO', stockClassRaw: 'MTO' }, india.stockClassMap, { rules, ood: 'IN' });
  assert.deepEqual(r0, { stockClass: 'NonMTS' });
});
