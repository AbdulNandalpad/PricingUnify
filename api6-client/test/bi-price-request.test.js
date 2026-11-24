const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApi6Client, buildBiPriceRequest, parseBiPriceResponse } = require('../src/index');

const item = (o = {}) => ({
  warehouseCode: '1020', lineId: '20', itemLongNumber: 'OR1600810-V9005', salesQuantity: '30000', unitCode: 'ZPC', itemTypeDesc: 'AGN',
  c4cUnitCostAmt: '0.03180000', costCurrencyCode: 'EUR', useCostPlusFlag: '1', uom: 'mm', stockClassGroupCode: 'MTO',
  supplierCountryCode: 'IT', supplierExternalID: '0001025396', supplierMainGroupCode: 'X_SIL', ...o,
});
const req = (items, customer = {}) => ({ requestorId: 'X_WSO2_READ', customer: { customerId: '0001035211', originOfData: 'SAP', countryCode: 'DE', custcurrency: 'EUR', ...customer }, item: items });

test('the real sample line passes through untouched except the supplier external ID loses its leading zeros', () => {
  const { body } = buildBiPriceRequest(req([item()]));
  assert.deepEqual(body.item[0], item({ supplierExternalID: '1025396' }));
});

test('unitCode CMT -> CM and uom MMT/CMT/INH -> mm/cm/in; other values are left alone', () => {
  const { body } = buildBiPriceRequest(req([item({ unitCode: 'CMT', uom: 'MMT' }), item({ uom: 'CMT' }), item({ uom: 'INH' }), item({ unitCode: 'ZPC', uom: 'mm' })]));
  assert.deepEqual(body.item.map((i) => [i.unitCode, i.uom]), [['CM', 'mm'], ['ZPC', 'cm'], ['ZPC', 'in'], ['ZPC', 'mm']]);
});

test('a blank item cost currency takes the customer currency; a given one is kept', () => {
  const { body } = buildBiPriceRequest(req([item({ costCurrencyCode: '' }), item({ costCurrencyCode: '  ' }), item({ costCurrencyCode: 'USD' })], { custcurrency: 'GBP' }));
  assert.deepEqual(body.item.map((i) => i.costCurrencyCode), ['GBP', 'GBP', 'USD']);
});

test('US customer + warehouse 1020 + supplier L_LCE -> stock class MTS (any other combination is untouched)', () => {
  const us = buildBiPriceRequest(req([item({ supplierMainGroupCode: 'L_LCE' })], { countryCode: 'US' })).body.item[0];
  assert.equal(us.stockClassGroupCode, 'MTS');
  assert.equal(buildBiPriceRequest(req([item({ supplierMainGroupCode: 'L_LCE' })], { countryCode: 'DE' })).body.item[0].stockClassGroupCode, 'MTO');
  assert.equal(buildBiPriceRequest(req([item({ supplierMainGroupCode: 'L_LCE', warehouseCode: '1030' })], { countryCode: 'US' })).body.item[0].stockClassGroupCode, 'MTO');
  assert.equal(buildBiPriceRequest(req([item()], { countryCode: 'US' })).body.item[0].stockClassGroupCode, 'MTO');
});

test('no item type and no opportunity: flag 0 and supplier code + country cleared — AFTER the stock-class override read the supplier (script order)', () => {
  const out = buildBiPriceRequest(req([item({ itemTypeDesc: '', supplierMainGroupCode: 'L_LCE' })], { countryCode: 'US' }), { defaultItemTypeDesc: '' }).body.item[0]; // default item type switched off = the CPI's literal behaviour
  assert.equal(out.stockClassGroupCode, 'MTS'); // override saw L_LCE first
  assert.equal(out.useCostPlusFlag, '0');
  assert.equal(out.supplierMainGroupCode, '');
  assert.equal(out.supplierCountryCode, '');
  assert.equal(out.supplierExternalID, '1025396'); // external ID is not cleared, only stripped
});

test('an opportunity id forces flag 0 and keeps the supplier data (cost-only calls)', () => {
  const out = buildBiPriceRequest(req([item({ itemTypeDesc: '' })], { opportunityId: 'OPP-7' })).body.item[0];
  assert.equal(out.useCostPlusFlag, '0');
  assert.equal(out.supplierMainGroupCode, 'X_SIL'); // the clearing rule needs "no opportunity"
  assert.equal(buildBiPriceRequest(req([item()], { opportunityId: 'OPP-7' })).body.item[0].useCostPlusFlag, '0');
});

test('a single item object is accepted like a list; the input is never mutated; originOfData is returned for the response step', () => {
  const input = req(item({ supplierExternalID: '0001025397' }));
  const snapshot = JSON.stringify(input);
  const { body, context } = buildBiPriceRequest(input);
  assert.equal(body.item.length, 1);
  assert.equal(body.item[0].supplierExternalID, '1025397');
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(context, { originOfData: 'SAP' });
});

test('the rules are DATA: an override mapping switches a rule off or changes it', () => {
  const noOverride = buildBiPriceRequest(req([item({ supplierMainGroupCode: 'L_LCE' })], { countryCode: 'US' }), { stockClassOverrides: [] }).body.item[0];
  assert.equal(noOverride.stockClassGroupCode, 'MTO');
  const custom = buildBiPriceRequest(req([item({ unitCode: 'CMT' })]), { unitCodeMap: { CMT: 'CMX' }, stripLeadingZerosFrom: [] }).body.item[0];
  assert.equal(custom.unitCode, 'CMX');
  assert.equal(custom.supplierExternalID, '0001025396');
});

const OK_RESPONSE = {
  status: { statusCode: 'SUCCESS', faultMessage: [] },
  calculatedPriceList: [
    { lineId: '20', itemLongNbr: 'OR1600810-V9005', salesQuantity: '30000', costPlusUnitAmt: '0.0364', costCurrencyCode: 'EUR', priceCurrencyCode: 'EUR', unitPriceAmt: '0.0816', fromQty: null, costAvailableFromQty: null, costFechedFrom: 'Cost was provided from C4C', messageCode: null, ccpMsg: null, explainCostDesc: '.0318 EUR (Unit Cost) x 30000 (Qty) x 1.048 (SCM Markup)' },
    { lineId: '40', itemLongNbr: 'OR1600810-V9005', salesQuantity: '1000', costPlusUnitAmt: '0.0456', costCurrencyCode: 'EUR', priceCurrencyCode: 'EUR', unitPriceAmt: null, costAvailableFromQty: '1', costFechedFrom: 'Cost was provided from C4C', messageCode: 'M1', ccpMsg: 'Site not found for supplier ID: X_SIL.' },
  ],
};

test('the real response shape is normalized per lineId; a non-SUCCESS status is FAILED with its fault messages', () => {
  const ok = parseBiPriceResponse(OK_RESPONSE);
  assert.equal(ok.status, 'OK');
  assert.deepEqual(ok.lines.map((l) => [l.lineId, l.costPlusUnitAmt, l.messageCode, l.unitPriceAmt]), [['20', '0.0364', '', '0.0816'], ['40', '0.0456', 'M1', null]]);
  assert.equal(ok.lines[1].ccpMessage, 'Site not found for supplier ID: X_SIL.');
  const failed = parseBiPriceResponse({ status: { statusCode: 'FAILED', faultMessage: ['Item not found', 'bad currency'] } });
  assert.deepEqual(failed, { status: 'FAILED', message: 'Item not found; bad currency', lines: [] });
});

test('fetchBiPriceList: live mode POSTs the MAPPED body to the configured endpoint; faults and network errors come back as FAILED; recorded mode makes no call', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, method: init.method, body: JSON.parse(init.body) }); return { ok: true, json: async () => OK_RESPONSE }; };
  const live = createApi6Client({ mode: 'live', baseUrl: 'https://apimqua.tss.trelleborg.com', fetchImpl });
  const res = await live.fetchBiPriceList(req([item({ unitCode: 'CMT' })]));
  assert.equal(res.status, 'OK');
  assert.equal(calls[0].url, 'https://apimqua.tss.trelleborg.com/core/price/rest/v1/getPriceList');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.item[0].unitCode, 'CM'); // the CPI mapping was applied before sending
  assert.equal(res.context.originOfData, 'SAP');

  const broken = createApi6Client({ mode: 'live', baseUrl: 'https://x', fetchImpl: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }) });
  const failed = await broken.fetchBiPriceList(req([item()]));
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.message, /503/);

  const recorded = createApi6Client({ mode: 'recorded' });
  const dry = await recorded.fetchBiPriceList(req([item()]));
  assert.equal(dry.status, 'RECORDED_MODE');
  assert.equal(dry.request.item[0].supplierExternalID, '1025396'); // shows what WOULD be sent
});

test('fetchBiCosts (TEMPORARY cost source): every line is sent with flag 0 and zero picks so the BI does not add our add-ons, and each answer becomes one cost candidate', async () => {
  const sent = [];
  // what the BI would answer for a flag-0 call: the raw cost (C4C-provided, CCD-found, and not found)
  const response = {
    status: { statusCode: 'SUCCESS', faultMessage: [] },
    calculatedPriceList: [
      { lineId: '20', costPlusUnitAmt: '0.0318', costCurrencyCode: 'EUR', costFechedFrom: 'Cost was provided from C4C', messageCode: null },
      { lineId: '40', costPlusUnitAmt: '0.0219', costCurrencyCode: 'EUR', costFechedFrom: 'Cost was provided from CCD', messageCode: 'M1', fromQty: '1' },
      { lineId: '50', costPlusUnitAmt: '0', costCurrencyCode: 'EUR', ccpMsg: 'Site not found for supplier ID: X_SIL.', costAvailableFromQty: '25' },
    ],
  };
  const live = createApi6Client({ mode: 'live', baseUrl: 'https://x', fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => response }; } });
  const res = await live.fetchBiCosts(req([item(), item({ lineId: '40' }), item({ lineId: '50' })]));

  assert.ok(sent[0].item.every((i) => i.useCostPlusFlag === '0' && i.c4cPickCount === 0), 'flag 0 and no picks on every line');
  assert.equal(res.status, 'OK');
  assert.deepEqual([res.candidates['20'].value, res.candidates['20'].source.system, res.candidates['20'].basis], ['0.0318', 'C4C', 'MANUAL']);
  assert.deepEqual([res.candidates['40'].value, res.candidates['40'].source.system, res.candidates['40'].basis, res.candidates['40'].fromQty], ['0.0219', 'CCD', 'SUPPLIER_CATALOG', '1']);
  assert.equal(res.candidates['50'].found, false);
  assert.match(res.candidates['50'].note, /Site not found/);
  assert.equal(res.candidates['50'].costAvailableFromQty, '25');

  const down = createApi6Client({ mode: 'live', baseUrl: 'https://x', fetchImpl: async () => ({ ok: false, status: 500, statusText: 'err' }) });
  assert.equal((await down.fetchBiCosts(req([item()]))).status, 'FAILED');
});

test('a line with no item type gets the default item type, so the supplier is NOT cleared', () => {
  const { buildBiPriceRequest } = require('../src/bi-price-request');
  const { body } = buildBiPriceRequest({ customer: {}, item: [{ lineId: '1', supplierMainGroupCode: 'X_SIL', supplierCountryCode: 'IT' }] });
  assert.equal(body.item[0].itemTypeDesc, 'AGN - Product');
  assert.equal(body.item[0].supplierMainGroupCode, 'X_SIL');
  // an explicit empty default restores the CPI's literal behaviour
  const cleared = buildBiPriceRequest({ customer: {}, item: [{ lineId: '1', supplierMainGroupCode: 'X_SIL' }] }, { defaultItemTypeDesc: '' });
  assert.equal(cleared.body.item[0].supplierMainGroupCode, '');
});
