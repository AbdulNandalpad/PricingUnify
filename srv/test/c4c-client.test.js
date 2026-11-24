const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createC4cClient } = require('../lib/c4c-client');

/** Unit tests against a fake fetch — the real C4C never exists in this sandbox, and the
 *  adapter's whole contract (typed NOT_CONFIGURED, CSRF + ETag mechanics, 412 -> typed
 *  conflict, OPPORTUNITY-never-writes-price) is testable without it. */

const DEST = { name: 'C4C_ODATA', url: 'https://my-c4c.example', username: 'tech-user', password: 'secret' };

function jsonRes(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    json: async () => body,
  };
}

/** A fake C4C: one quote Q-1 with items EU-T100 and P-10023, recording every request. */
function fakeC4c({ patchStatus = 204 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'GET' && init.headers['x-csrf-token'] === 'fetch') {
      return jsonRes({}, { headers: { 'x-csrf-token': 'csrf-123' } });
    }
    if (init.method === 'GET' && url.includes('SalesQuoteCollection') || (init.method === 'GET' && url.includes('OpportunityCollection'))) {
      return jsonRes({ d: { results: [{ ObjectID: 'HDR-OBJ-1', __metadata: { etag: 'W/"hdr-1"' } }] } });
    }
    if (init.method === 'GET' && (url.includes('SalesQuoteItemCollection') || url.includes('OpportunityItemCollection'))) {
      return jsonRes({ d: { results: [
        { ObjectID: 'ITM-1', ProductInternalID: 'EU-T100', __metadata: { etag: 'W/"itm-1"' } },
        { ObjectID: 'ITM-2', ProductInternalID: 'P-10023', __metadata: { etag: 'W/"itm-2"' } },
      ] } });
    }
    if (init.method === 'PATCH') {
      return jsonRes({}, { status: patchStatus });
    }
    throw new Error('unexpected call: ' + init.method + ' ' + url);
  };
  return { calls, fetchImpl };
}

test('no destination configured -> typed C4C_NOT_CONFIGURED, nothing attempted', async () => {
  const client = createC4cClient({ resolveDestination: () => null, fetchImpl: () => { throw new Error('must not be called'); } });
  const res = await client.writeBack({ objectType: 'QUOTE', objectId: 'Q-1', items: [{ partNumber: 'EU-T100' }], user: 'alice' });
  assert.equal(res.status, 'C4C_NOT_CONFIGURED');
  assert.match(res.message, /C4C_ODATA/);
});

test('QUOTE write-back: ETag-guarded item PATCHes with the mapped fields, then the header audit flags', async () => {
  const c4c = fakeC4c();
  const fixedNow = new Date('2026-11-24T10:00:00Z');
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl: c4c.fetchImpl, now: () => fixedNow });

  const res = await client.writeBack({
    objectType: 'QUOTE', objectId: 'Q-1', user: 'alice',
    items: [{ partNumber: 'EU-T100', cost: '100.00', landedCost: '130.78', price: '130.78', marginPct: '23.5 %', pricingType: 'COST_PLUS' }],
  });
  assert.equal(res.status, 'OK');
  assert.equal(res.written, 1);

  const itemPatch = c4c.calls.find((c) => c.method === 'PATCH' && c.url.includes("SalesQuoteItemCollection('ITM-1')"));
  assert.ok(itemPatch, 'item ITM-1 was patched');
  assert.equal(itemPatch.headers['If-Match'], 'W/"itm-1"'); // never a blind overwrite
  assert.equal(itemPatch.headers['x-csrf-token'], 'csrf-123');
  assert.equal(itemPatch.body.Price_SDK, '130.78');
  assert.equal(itemPatch.body.LandedCost_SDK, '130.78');
  assert.equal(itemPatch.body.Cost_SDK, '100.00');
  assert.equal(itemPatch.body.PricingType_SDK, 'COST_PLUS');

  const headerPatch = c4c.calls.find((c) => c.method === 'PATCH' && c.url.includes("SalesQuoteCollection('HDR-OBJ-1')"));
  assert.ok(headerPatch, 'header audit flags were written');
  assert.equal(headerPatch.body.ExternallyPriced_SDK, true);
  assert.equal(headerPatch.body.PricedBy_SDK, 'alice'); // always the logged-in user
  assert.equal(headerPatch.body.PricedOn_SDK, fixedNow.toISOString());
});

test('OPPORTUNITY write-back NEVER writes a price or margin, whatever the caller sends', async () => {
  const c4c = fakeC4c();
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl: c4c.fetchImpl });

  const res = await client.writeBack({
    objectType: 'OPPORTUNITY', objectId: 'O-9', user: 'bob',
    items: [{ partNumber: 'EU-T100', cost: '100.00', landedCost: '130.78', price: '130.78', marginPct: '23.5 %', pricingType: 'COST_PLUS' }],
  });
  assert.equal(res.status, 'OK');

  const itemPatch = c4c.calls.find((c) => c.method === 'PATCH' && c.url.includes('OpportunityItemCollection'));
  assert.ok(itemPatch);
  assert.equal(itemPatch.body.Price_SDK, undefined);
  assert.equal(itemPatch.body.MarginPercent_SDK, undefined);
  assert.equal(itemPatch.body.LandedCost_SDK, '130.78'); // cost fields still go
  const headerPatch = c4c.calls.find((c) => c.method === 'PATCH' && c.url.includes('OpportunityCollection('));
  assert.equal(headerPatch.body.ExternallyPriced_SDK, true); // audit flags on both object types
});

test('a 412 on an item PATCH is the typed conflict outcome, naming the part', async () => {
  const c4c = fakeC4c({ patchStatus: 412 });
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl: c4c.fetchImpl });
  const res = await client.writeBack({
    objectType: 'QUOTE', objectId: 'Q-1', user: 'alice',
    items: [{ partNumber: 'EU-T100', landedCost: '130.78' }],
  });
  assert.equal(res.status, 'C4C_CONFLICT');
  assert.equal(res.message, 'Object changed in C4C, reload.');
  assert.deepEqual(res.partNumbers, ['EU-T100']);
});

test('a product that is not an item of the C4C object is a typed error, not a silent skip', async () => {
  const c4c = fakeC4c();
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl: c4c.fetchImpl });
  const res = await client.writeBack({
    objectType: 'QUOTE', objectId: 'Q-1', user: 'alice',
    items: [{ partNumber: 'NOT-ON-QUOTE', landedCost: '1.00' }],
  });
  assert.equal(res.status, 'C4C_ERROR');
  assert.match(res.message, /NOT-ON-QUOTE/);
});

test('the field map is configuration: an override changes what gets written, not the code', async () => {
  const c4c = fakeC4c();
  const client = createC4cClient({
    resolveDestination: () => DEST,
    fetchImpl: c4c.fetchImpl,
    fieldMap: { price: 'zNetPrice', landedCost: 'zLandedCost' },
  });
  await client.writeBack({
    objectType: 'QUOTE', objectId: 'Q-1', user: 'alice',
    items: [{ partNumber: 'EU-T100', landedCost: '130.78', price: '130.78' }],
  });
  const itemPatch = c4c.calls.find((c) => c.method === 'PATCH' && c.url.includes('SalesQuoteItemCollection'));
  assert.equal(itemPatch.body.zNetPrice, '130.78');
  assert.equal(itemPatch.body.zLandedCost, '130.78');
  assert.equal(itemPatch.body.Price_SDK, undefined);
});

// --- READ side: fetchObjectItems (fill the pricing grid from a C4C object) ---

function fakeC4cRead() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.includes('SalesQuoteCollection?')) {
      return jsonRes({ d: { results: [{ ObjectID: 'HDR-OBJ-1', BuyerPartyName: 'Boston Scientific', BuyerPartyID: '32539', CurrencyCode: 'EUR' }] } });
    }
    if (url.includes('CorporateAccountCollection?')) {
      // Real account row (account 32539): note CURRENCY_KUT is genuinely empty on this tenant.
      return jsonRes({ d: { results: [{ ObjectID: 'ACC-OBJ-1', AccountID: '32539', ExternalID: '0001035211', ExternalSystem: 'SAP',
        CustomerABCClassificationCode: 'A', CountryCode: 'DE', SALESTERRITORYDETCODE: 'GJ1', CURRENCY_KUT: '', OOD_Routing_KUT: '' }] } });
    }
    if (url.includes('SalesQuoteItemCollection?')) {
      return jsonRes({ d: { results: [
        { ObjectID: 'ITM-1', ItemID: '10', ProductInternalID: 'EU-T100', PROD_DESC: 'Seal kit', Quantity: '10.00000000000000', QuantityMeasureUnitCode: 'EA',
          ZProductBuyerID: 'CUST-4711', OriginOfDataID: 'SAP', WarehouseID: 'EU01', ZNumberOfPicks: '2', ZLeadTime: '6', ZAddCost_KUT: '1',
          ProductCategoryID: 'OR', PriceBreakIndicator_KUT: false, AlternativeToItemID: '' },
        { ObjectID: 'ITM-2', ItemID: '20', ProductInternalID: 'P-10023', Quantity: '5' },
      ] } });
    }
    throw new Error('unexpected: ' + url);
  };
  return { calls, fetchImpl };
}

test('fetchObjectItems returns the header context and every grid column the Products tab carries', async () => {
  const c4c = fakeC4cRead();
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl: c4c.fetchImpl });
  const res = await client.fetchObjectItems({ objectType: 'QUOTE', objectId: 'Q-140981' });
  assert.equal(res.status, 'OK');
  assert.deepEqual(res.header, { account: 'Boston Scientific', currency: 'EUR' });
  assert.equal(res.items.length, 2);
  assert.deepEqual(res.items[0], {
    itemId: '10', partNumber: 'EU-T100', description: 'Seal kit', quantity: '10.00000000000000', uom: 'EA',
    customerPartNumber: 'CUST-4711', ood: 'SAP', warehouse: 'EU01', picks: '2', leadTime: '6',
    additionalCost: '1', supplier: '', // no supplier field on the quote item (confirmed on the real tenant)
    productCategory: 'OR', priceBreak: false, alternativeToLine: '',
  });
  assert.equal(res.items[1].partNumber, 'P-10023'); // sparse rows come back with empty strings, never undefined keys
  assert.equal(res.items[1].ood, '');
});

test('fetchObjectItems distinguishes "no URL" from "URL set but credentials missing" — both typed, nothing called', async () => {
  const none = createC4cClient({ resolveDestination: () => null, fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal((await none.fetchObjectItems({ objectType: 'QUOTE', objectId: 'Q-1' })).status, 'C4C_NOT_CONFIGURED');

  const urlOnly = createC4cClient({
    resolveDestination: () => ({ name: 'C4C_ODATA', url: 'https://my332854.crm.ondemand.com', username: null, password: null }),
    fetchImpl: () => { throw new Error('must not call'); },
  });
  const res = await urlOnly.fetchObjectItems({ objectType: 'QUOTE', objectId: 'Q-1' });
  assert.equal(res.status, 'C4C_CREDENTIALS_MISSING');
  assert.match(res.message, /C4C_USERNAME/);
});

test('searchProducts queries the material collection and maps id/description; typed when unconfigured', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    return jsonRes({ d: { results: [
      { ID: 'EU-T100', Description: 'Verification part' },
      { ID: 'EU-T200', Description: null },
    ] } });
  };
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl });
  const res = await client.searchProducts({ query: 'EU-T' });
  assert.equal(res.status, 'OK');
  assert.equal(res.source, 'C4C');
  assert.deepEqual(res.products, [
    { id: 'EU-T100', description: 'Verification part' },
    { id: 'EU-T200', description: '' },
  ]);
  assert.match(calls[0], /ProductCollection\?\$filter=startswith\(ID,'EU-T'\)/);
  // Product master lives on the full c4codata service, not the c4codataapi one used for quotes.
  assert.match(calls[0], /\/sap\/c4c\/odata\/v1\/c4codata\/ProductCollection/);

  const offline = createC4cClient({ resolveDestination: () => null, fetchImpl: () => { throw new Error('no'); } });
  assert.equal((await offline.searchProducts({ query: 'EU-T' })).status, 'C4C_NOT_CONFIGURED');
});

test('fetchProductDetails looks up a set of parts in one or-filtered call and maps description/base UoM', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonRes({ d: { results: [
      { ID: 'ORAR00125-N7H07', Description: 'O-Rings', UnitOfMeasureCode: 'EA' },
      { ID: 'EU-T100', Description: 'Verification part', UnitOfMeasureCode: null },
    ] } });
  };
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl });
  const res = await client.fetchProductDetails({ partNumbers: ['ORAR00125-N7H07', 'EU-T100', 'ORAR00125-N7H07', '  '] });
  assert.equal(res.status, 'OK');
  assert.deepEqual(res.products, {
    'ORAR00125-N7H07': { description: 'O-Rings', uom: 'EA', sales: [] },
    'EU-T100': { description: 'Verification part', uom: '', sales: [] },
  });
  assert.match(calls[0], /&\$expand=ProductSales/);
  // One call, duplicates/blanks dropped, or-joined filter against the material collection.
  assert.equal(calls.length, 1);
  assert.match(calls[0], /ProductCollection\?\$filter=ID eq 'ORAR00125-N7H07' or ID eq 'EU-T100'/);

  // No parts -> nothing called, empty OK. Unconfigured -> typed, nothing called.
  assert.deepEqual(await client.fetchProductDetails({ partNumbers: [] }), { status: 'OK', products: {} });
  const offline = createC4cClient({ resolveDestination: () => null, fetchImpl: () => { throw new Error('no'); } });
  assert.equal((await offline.fetchProductDetails({ partNumbers: ['X'] })).status, 'C4C_NOT_CONFIGURED');
});

test('fetchProductDetails returns the raw stock class per sales org from the ProductSales expand, and retries without $expand if the tenant rejects it', async () => {
  const urls = [];
  const withSales = async (url) => {
    urls.push(url);
    return jsonRes({ d: { results: [{
      ID: 'ORAR00125-N7H07', Description: 'O-Rings', UnitOfMeasureCode: 'EA',
      ProductSales: { results: [
        { SalesOrganisationID: 'SO1', StockClass: 'MTS' },
        { SalesOrganisationID: 'SO2', StockClass: 'OMT' },
      ] },
    }] } });
  };
  const ok = await createC4cClient({ resolveDestination: () => DEST, fetchImpl: withSales }).fetchProductDetails({ partNumbers: ['ORAR00125-N7H07'] });
  assert.deepEqual(ok.products['ORAR00125-N7H07'].sales, [
    { salesOrg: 'SO1', stockClassRaw: 'MTS' },
    { salesOrg: 'SO2', stockClassRaw: 'OMT' },
  ]);

  const retry = [];
  const rejectsExpand = async (url) => {
    retry.push(url);
    if (url.includes('$expand')) return { ok: false, status: 400, json: async () => ({}) };
    return jsonRes({ d: { results: [{ ID: 'X', Description: 'Plain', UnitOfMeasureCode: 'PC' }] } });
  };
  const fallback = await createC4cClient({ resolveDestination: () => DEST, fetchImpl: rejectsExpand }).fetchProductDetails({ partNumbers: ['X'] });
  assert.equal(fallback.status, 'OK');
  assert.equal(retry.length, 2); // expand attempt, then plain
  assert.deepEqual(fallback.products.X, { description: 'Plain', uom: 'PC', sales: [] });
});

test('fetchOriginOfDataRows reads the OriginOfData service (supplier + warehouse) and maps the real row shape', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('OriginOfDataSupplierCollection')) {
      return jsonRes({ d: { results: [{
        MaterialID: 'ORAR00125-N7H07', OriginOfDataID: 'SMA', OriginOfDataID1: 'SMA',
        GlobalSupplierCode: 'X_TUI', ExternalID: '113955', SupplierName: 'Tuico Products SJC', DefaultSupplier: false,
      }] } });
    }
    return jsonRes({ d: { results: [{
      MaterialID: 'ORAR00125-N7H07', OriginOfDataID: 'SMA', WarehouseID: 'LG01', StockClass: 'OMT', LeadTime: '14', Country_WH: 'US', PreferredWarehouse: true,
    }] } });
  };
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl });
  const res = await client.fetchOriginOfDataRows({ partNumbers: ['ORAR00125-N7H07', 'ORAR00125-N7H07'] });
  assert.equal(res.status, 'OK');
  assert.deepEqual(res.suppliers, [{ partNumber: 'ORAR00125-N7H07', ood: 'SMA', parentOod: 'SMA', supplierId: 'X_TUI', externalId: '113955', name: 'Tuico Products SJC', isDefault: false }]);
  assert.deepEqual(res.warehouses, [{ partNumber: 'ORAR00125-N7H07', ood: 'SMA', warehouseId: 'LG01', stockClassRaw: 'OMT', leadTime: '14', country: 'US', preferred: true }]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((u) => u.includes('/sap/c4c/odata/cust/v1/originofdata/')));
  assert.match(calls[0], /OriginOfDataSupplierCollection\?\$filter=MaterialID eq 'ORAR00125-N7H07'&\$top=500/);

  assert.deepEqual(await client.fetchOriginOfDataRows({ partNumbers: [] }), { status: 'OK', suppliers: [], warehouses: [] });
  const denied = createC4cClient({ resolveDestination: () => DEST, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
  const err = await denied.fetchOriginOfDataRows({ partNumbers: ['X'] });
  assert.equal(err.status, 'C4C_ERROR');
  assert.match(err.message, /HTTP 403 on \/sap\/c4c\/odata\/cust\/v1\/originofdata\//);
  const offline = createC4cClient({ resolveDestination: () => null, fetchImpl: () => { throw new Error('no'); } });
  assert.equal((await offline.fetchOriginOfDataRows({ partNumbers: ['X'] })).status, 'C4C_NOT_CONFIGURED');
});

test('fetchObjectItems also reads the customer header from the account (BuyerPartyID -> CorporateAccount), with the quote currency as the labelled fallback', async () => {
  const c4c = fakeC4cRead();
  const client = createC4cClient({ resolveDestination: () => DEST, fetchImpl: c4c.fetchImpl });
  const res = await client.fetchObjectItems({ objectType: 'QUOTE', objectId: '235616' });
  assert.deepEqual(res.customer, {
    accountId: '32539', quoteId: '235616', note: '',
    customerId: '0001035211', originOfData: 'SAP', originOfDataSource: 'ExternalSystem',
    classCode: 'A', countryCode: 'DE', salesTerritory: 'GJ1',
    currency: 'EUR', currencySource: 'QUOTE', // CURRENCY_KUT empty -> the quote's currency, and it says so
    priceGroup: '', // price-group field not confirmed yet -> not read, never invented
  });
  assert.ok(c4c.calls.some((c) => /CorporateAccountCollection\?\$filter=AccountID eq '32539'/.test(c.url)));
});

test('a failed customer lookup never fails the item fetch — the customer carries a note', async () => {
  const base = fakeC4cRead().fetchImpl;
  const fetchImpl = async (url, init) => (url.includes('CorporateAccountCollection?') ? { ok: false, status: 403, json: async () => ({}) } : base(url, init));
  const res = await createC4cClient({ resolveDestination: () => DEST, fetchImpl }).fetchObjectItems({ objectType: 'QUOTE', objectId: '235616' });
  assert.equal(res.status, 'OK');
  assert.equal(res.items.length, 2);
  assert.equal(res.customer.accountId, '32539');
  assert.match(res.customer.note, /HTTP 403/);
});
