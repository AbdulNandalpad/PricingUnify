const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBiBody, applyBiCandidates } = require('../lib/bi-cost');

const items = [
  { partNumber: 'OR1', quantity: 10, warehouse: '1020', supplier: 'X_SIL', supplierExternalId: '0001025396', stockClass: 'NonMTS', uom: 'PC' },
  { partNumber: 'OR1', quantity: 50, stockClass: 'MTS' },
];

test('buildBiBody asks for the cost alone (flag 0, zero picks) with customer block and 1-based lineIds', () => {
  const b = buildBiBody({ items, customerId: '0001035211', customerOod: 'SAP', customer: { countryCode: 'DE', currency: 'EUR', salesTerritory: 'GJ1' }, hostObjectId: '235616', userId: 'bob' });
  assert.equal(b.customer.customerId, '0001035211');
  assert.equal(b.customer.originOfData, 'SAP');
  assert.equal(b.customer.quoteId, '235616');
  assert.deepEqual(b.item.map((i) => i.lineId), ['1', '2']);
  assert.equal(b.item[0].stockClassGroupCode, 'MTO'); // NonMTS -> the raw group the BI speaks
  assert.equal(b.item[1].stockClassGroupCode, 'MTS');
  assert.equal(b.item[0].supplierMainGroupCode, 'X_SIL');
  assert.equal(b.item[0].salesQuantity, 10);
  assert.equal(b.item[0].itemTypeDesc, ''); // no item type typed -> blank, the client applies the configured default
  assert.equal(buildBiBody({ items: [{ partNumber: 'P', quantity: 1, itemType: 'AGN' }] }).item[0].itemTypeDesc, 'AGN');
  assert.ok(b.item.every((i) => i.useCostPlusFlag === '0' && i.c4cPickCount === 0));
});

test('applyBiCandidates selects the BI cost per line and records why a line got none', () => {
  const facts = { costs: {} };
  const bi = { status: 'OK', endpoint: '/core/price/rest/v1/getPriceList', candidates: {
    1: { found: true, value: '0.0318', currency: 'EUR', basis: 'SUPPLIER_CATALOG', source: { system: 'CCD', table: 'getPriceList', field: 'costPlusUnitAmt' }, confidence: 'EXACT' },
    2: { found: false, note: 'no cost returned' },
  } };
  const routing = applyBiCandidates(facts, items, bi);
  assert.equal(items[0].selectedCostId, 'BI_OR1_1');
  assert.equal(facts.costs.OR1.candidates[0].value, '0.0318');
  assert.equal(facts.costs.OR1.candidates[0].source.key, 'BI_OR1_1');
  assert.equal(routing.get(items[0])[0].calls[0].found, true);
  assert.equal(items[1].selectedCostId, undefined);
  assert.equal(routing.get(items[1])[0].calls[0].note, 'no cost returned');
});

test('a failed BI call leaves every line without a cost and says why', () => {
  const its = [{ partNumber: 'P', quantity: 1 }];
  const routing = applyBiCandidates({ costs: {} }, its, { status: 'FAILED', message: 'HTTP 401', endpoint: '/x' });
  assert.equal(its[0].selectedCostId, undefined);
  assert.match(routing.get(its[0])[0].calls[0].note, /FAILED: HTTP 401/);
});

test('hand-added lines fall back to their own Origin of Data for the BI customer block, and the trace carries the payload', () => {
  const its = [{ partNumber: 'P', quantity: 1, ood: 'SAP' }, { partNumber: 'P', quantity: 5, ood: 'SAP' }];
  assert.equal(buildBiBody({ items: its }).customer.originOfData, 'SAP');
  assert.equal(buildBiBody({ items: its, customerOod: 'CN' }).customer.originOfData, 'CN'); // explicit wins
  const mixed = [{ partNumber: 'P', ood: 'SAP' }, { partNumber: 'Q', ood: 'CN' }];
  assert.equal(buildBiBody({ items: mixed }).customer.originOfData, ''); // never guessed when they disagree

  const bi = { status: 'OK', endpoint: '/x', request: buildBiBody({ items: its }), raw: { calculatedPriceList: [{ lineId: '1', costPlusUnitAmt: 0 }, { lineId: '2', costPlusUnitAmt: 0 }] },
    candidates: { 1: { found: false, note: 'no cost returned' }, 2: { found: false, note: 'no cost returned' } } };
  const routing = applyBiCandidates({ costs: {} }, its, bi);
  const payload = routing.get(its[0])[0].calls[0].payload;
  assert.equal(payload.request.item.itemLongNumber, 'P');
  assert.equal(payload.request.customer.originOfData, 'SAP');
  assert.equal(payload.answer.lineId, '1');
});
