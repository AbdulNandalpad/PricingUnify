const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigStore } = require('../src/store');
const { validateSupplierConfig, ConfigValidationError } = require('../src/validate');
const { HUMAN_PROVENANCE } = require('./fixtures');

function supplierConfig(overrides = {}) {
  return {
    supplier: 'ACME',
    version: '2026.08.0',
    status: 'ACTIVE',
    validFrom: '2026-08-01',
    validTo: null,
    supplierCountry: 'DE',
    molv: '50.00',
    moq: '1',
    warehouses: {
      EU01: { freight: '5.00', duty: '2.00', tariff: '0' },
    },
    provenance: HUMAN_PROVENANCE,
    ...overrides,
  };
}

test('a well-formed supplier-config validates cleanly', () => {
  assert.equal(validateSupplierConfig(supplierConfig()), true);
});

test('fields are individually optional — a supplier can set just supplierCountry with no warehouses at all', () => {
  const config = supplierConfig({ molv: undefined, moq: undefined, warehouses: undefined });
  delete config.molv;
  delete config.moq;
  delete config.warehouses;
  assert.equal(validateSupplierConfig(config), true);
});

test('a supplier is global — no region/salesOrg scoping — and can declare charges for several warehouses at once', () => {
  const store = new ConfigStore();
  store.saveSupplierConfig(supplierConfig({
    warehouses: {
      EU01: { freight: '18.00', duty: '9.50', tariff: '12.00' },
      US01: { freight: '25.00', duty: '15.00', tariff: '20.00' },
    },
  }));

  const acme = store.getEffectiveSupplierConfig('ACME', '2026-08-15');
  assert.equal(acme.supplier, 'ACME');
  assert.equal(acme.warehouses.EU01.freight, '18.00');
  assert.equal(acme.warehouses.US01.freight, '25.00');
});

test('with no supplier-config record, resolution returns null (not a crash) — no wildcard fallback', () => {
  const store = new ConfigStore();
  assert.equal(store.getEffectiveSupplierConfig('ACME', '2026-08-15'), null);
});

test('saveSupplierConfig rejects an invalid document and never mutates the store', () => {
  const store = new ConfigStore();
  const bad = supplierConfig({ validTo: '2020-01-01' }); // before validFrom
  assert.throws(() => store.saveSupplierConfig(bad), ConfigValidationError);
  assert.equal(store.listSupplierConfigVersions('ACME').length, 0);
});

test('supersession works the same as region-config: closes the old window, no overlap', () => {
  const store = new ConfigStore();
  store.saveSupplierConfig(supplierConfig({ warehouses: { EU01: { freight: '5.00' } } }));
  store.saveSupplierConfig(supplierConfig({ version: '2026.09.0', validFrom: '2026-09-01', warehouses: { EU01: { freight: '6.00' } } }));

  assert.equal(store.getEffectiveSupplierConfig('ACME', '2026-08-15').warehouses.EU01.freight, '5.00');
  assert.equal(store.getEffectiveSupplierConfig('ACME', '2026-09-15').warehouses.EU01.freight, '6.00');
});

test('listSuppliers returns every supplier with an effective document, globally', () => {
  const store = new ConfigStore();
  store.saveSupplierConfig(supplierConfig({ supplier: 'ACME' }));
  store.saveSupplierConfig(supplierConfig({ supplier: 'GLOBEX', supplierCountry: 'NL' }));

  const ids = store.listSuppliers('2026-08-15').map((s) => s.supplier).sort();
  assert.deepEqual(ids, ['ACME', 'GLOBEX']);
});
