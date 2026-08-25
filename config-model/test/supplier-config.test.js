const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigStore } = require('../src/store');
const { validateSupplierConfig, ConfigValidationError } = require('../src/validate');
const { HUMAN_PROVENANCE } = require('./fixtures');

function supplierConfig(overrides = {}) {
  return {
    region: 'EUROPE',
    salesOrg: '*',
    supplier: '*',
    version: '2026.08.0',
    status: 'ACTIVE',
    validFrom: '2026-08-01',
    validTo: null,
    freight: '5.00',
    duty: '2.00',
    tariff: '0',
    molv: '50.00',
    moq: '1',
    provenance: HUMAN_PROVENANCE,
    ...overrides,
  };
}

test('a well-formed supplier-config validates cleanly', () => {
  assert.equal(validateSupplierConfig(supplierConfig()), true);
});

test('fields are individually optional — a supplier can override just one', () => {
  const config = supplierConfig({ freight: undefined, duty: undefined, tariff: '5.00', molv: undefined, moq: undefined, supplier: 'ACME' });
  delete config.freight;
  delete config.duty;
  delete config.molv;
  delete config.moq;
  assert.equal(validateSupplierConfig(config), true);
});

test('a specific supplier overrides the region-wide "*" default for dates it covers', () => {
  const store = new ConfigStore();
  store.saveSupplierConfig(supplierConfig()); // '*' default
  store.saveSupplierConfig(supplierConfig({ supplier: 'ACME', version: 'ACME-2026.08.0', freight: '12.00', duty: '5.00', tariff: '3.00', molv: '200.00', moq: '50' }));

  const acme = store.getEffectiveSupplierConfig('EUROPE', '*', 'ACME', '2026-08-15');
  assert.equal(acme.supplier, 'ACME');
  assert.equal(acme.freight, '12.00');

  const other = store.getEffectiveSupplierConfig('EUROPE', '*', 'GLOBEX', '2026-08-15');
  assert.equal(other.supplier, '*', 'a supplier with no override still gets the region-wide default');
  assert.equal(other.freight, '5.00');
});

test('with no "*" default and no specific-supplier record, resolution returns null (not a crash)', () => {
  const store = new ConfigStore();
  assert.equal(store.getEffectiveSupplierConfig('EUROPE', '*', 'ACME', '2026-08-15'), null);
});

test('saveSupplierConfig rejects an invalid document and never mutates the store', () => {
  const store = new ConfigStore();
  const bad = supplierConfig({ validTo: '2020-01-01' }); // before validFrom
  assert.throws(() => store.saveSupplierConfig(bad), ConfigValidationError);
  assert.equal(store.listSupplierConfigVersions('EUROPE', '*', '*').length, 0);
});

test('supersession works the same as region-config: closes the old window, no overlap', () => {
  const store = new ConfigStore();
  store.saveSupplierConfig(supplierConfig({ freight: '5.00' }));
  store.saveSupplierConfig(supplierConfig({ version: '2026.09.0', validFrom: '2026-09-01', freight: '6.00' }));

  assert.equal(store.getEffectiveSupplierConfig('EUROPE', '*', '*', '2026-08-15').freight, '5.00');
  assert.equal(store.getEffectiveSupplierConfig('EUROPE', '*', '*', '2026-09-15').freight, '6.00');
});
