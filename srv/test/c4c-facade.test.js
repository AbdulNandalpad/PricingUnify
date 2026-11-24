'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { store } = require('../lib/store');
const { seed } = require('../lib/seed');
const { translateCustomerPriceListRequest } = require('../lib/c4c-facade');

seed(); // seeds the process-wide store (a separate srv test process, so no clash with the api tests)

// Request taken from a real BI price call (quote 235616).
const line = (o) => ({
  warehouseCode: '1020', buNumber: '1020', lineId: '20', itemLongNumber: 'OR1600810-V9005', salesQuantity: '30000', unitCode: 'ZPC',
  c4cUnitPriceAmt: '0.08160000', priceCurrencyCode: 'EUR', c4cUnitCostAmt: '0.03180000', c4cPickCount: 1, useCostPlusFlag: '1',
  stockClassGroupCode: 'MTO', supplierCountryCode: 'IT', supplierExternalID: '0001025396', supplierMainGroupCode: 'X_SIL', ...o,
});
const body = (o = {}, items = [line()]) => ({
  requestorId: 'X_WSO2_READ',
  customer: { customerId: '0001035211', salesTerritory: 'GJ1', originOfData: 'SAP', countryCode: 'DE', custcurrency: 'EUR', priceGroup: 'X0', classCode: 'A', quoteId: '235616', ...o },
  item: items,
});

test('both supplier identifiers are carried: supplierMainGroupCode is the supplier ID, supplierExternalID the external ID', () => {
  const t = translateCustomerPriceListRequest(body(), { store, priceDate: '2026-11-24' });
  const it = t.payload.items[0];
  assert.equal(t.region, 'EUROPE');
  assert.equal(it.supplier, 'X_SIL');
  assert.equal(it.supplierExternalId, '0001025396');
  assert.equal(it.supplierCountry, 'IT');
  assert.equal(it.warehouse, '1020');
  assert.equal(it.quantity, 30000);
  assert.equal(it.stockClass, 'NonMTS'); // MTO via EUROPE's stockClassMap
});

test('an older caller that only sends supplierExternalID keeps working (it becomes the supplier key)', () => {
  const t = translateCustomerPriceListRequest(body({}, [line({ supplierMainGroupCode: undefined, supplierExternalID: 'ACME' })]), { store, priceDate: '2026-11-24' });
  assert.equal(t.payload.items[0].supplier, 'ACME');
  assert.equal(t.payload.items[0].supplierExternalId, 'ACME');
});

test('useCostPlusFlag is the Additional Cost flag — mapped only for regions that declare an additionalCostMap', () => {
  const eu = translateCustomerPriceListRequest(body(), { store, priceDate: '2026-11-24' });
  assert.equal(eu.payload.items[0].additionalCost, '1');
  const us = translateCustomerPriceListRequest(body({ originOfData: 'SMA' }), { store, priceDate: '2026-11-24' });
  assert.equal(us.region, 'AMERICAS');
  assert.equal(us.payload.items[0].additionalCost, undefined); // AMERICAS has no map -> flag is not forwarded
});

test('a non-zero c4cUnitCostAmt becomes hostCost (needs its currency); a zero or currency-less cost adds nothing', () => {
  const t = (o) => translateCustomerPriceListRequest(body({}, [line(o)]), { store, priceDate: '2026-11-24' }).payload.items[0].hostCost;
  assert.deepEqual(t({ c4cUnitCostAmt: '0.03180000', costCurrencyCode: 'EUR' }), { value: '0.03180000', currency: 'EUR' });
  assert.equal(t({ c4cUnitCostAmt: '0.000000', costCurrencyCode: 'EUR' }), undefined); // the real line 40: cost 0 -> CCD lookup
  assert.equal(t({ c4cUnitCostAmt: '0.0318', costCurrencyCode: '' }), undefined); // a currency is never guessed
});
