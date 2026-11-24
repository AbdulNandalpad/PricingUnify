'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProductStockClass } = require('../lib/product-stock-class');

const MAP = { MTS: 'MTS', 'MTS-Z': 'MTS', OMT: 'NonMTS' };

test('one raw code is mapped through the region stockClassMap', () => {
  assert.deepEqual(resolveProductStockClass([{ salesOrg: 'SO1', stockClassRaw: 'OMT' }], { salesOrg: '*', map: MAP }),
    { stockClassRaw: 'OMT', stockClass: 'NonMTS' });
});

test('the quote sales org picks its own row when sales orgs disagree', () => {
  const sales = [{ salesOrg: 'SO1', stockClassRaw: 'MTS' }, { salesOrg: 'SO2', stockClassRaw: 'OMT' }];
  assert.equal(resolveProductStockClass(sales, { salesOrg: 'SO2', map: MAP }).stockClass, 'NonMTS');
  assert.equal(resolveProductStockClass(sales, { salesOrg: 'SO1', map: MAP }).stockClass, 'MTS');
});

test('disagreeing sales orgs with no sales org known is AMBIGUOUS — never a guess', () => {
  const sales = [{ salesOrg: 'SO1', stockClassRaw: 'MTS' }, { salesOrg: 'SO2', stockClassRaw: 'OMT' }];
  const res = resolveProductStockClass(sales, { salesOrg: '*', map: MAP });
  assert.equal(res.stockClass, undefined);
  assert.match(res.note, /^AMBIGUOUS:/);
});

test('unmapped code, missing map and empty data each come back as a typed note, not a value', () => {
  assert.deepEqual(resolveProductStockClass([{ salesOrg: 'S', stockClassRaw: 'ZZZ' }], { map: MAP }), { stockClassRaw: 'ZZZ', note: 'UNMAPPED:ZZZ' });
  assert.equal(resolveProductStockClass([{ salesOrg: 'S', stockClassRaw: 'MTS' }], { map: null }).note, 'NO_STOCK_CLASS_MAP_FOR_REGION');
  assert.deepEqual(resolveProductStockClass([], { map: MAP }), { note: 'NO_STOCK_CLASS_IN_C4C' });
  assert.deepEqual(resolveProductStockClass([{ salesOrg: 'S', stockClassRaw: '' }], { map: MAP }), { note: 'NO_STOCK_CLASS_IN_C4C' });
});
