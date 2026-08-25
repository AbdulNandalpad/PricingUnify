const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRegionConfig, ConfigValidationError } = require('../src/validate');
const { europeConfig, HUMAN_PROVENANCE } = require('./fixtures');
const { price } = require('@tss-pricing/engine-core');

test('stockClassMap is a valid optional field on region-config', () => {
  const config = europeConfig({ stockClassMap: { MTS: 'MTS', 'MTS-Z': 'MTS', OMT: 'NonMTS', CMT: 'NonMTS' } });
  assert.equal(validateRegionConfig(config), true);
});

test('stockClassMap rejects a value outside MTS/NonMTS', () => {
  const config = europeConfig({ stockClassMap: { OMT: 'SOMETHING_ELSE' } });
  assert.throws(() => validateRegionConfig(config), ConfigValidationError);
});

test('a config-model-authored stockClassMap does not by itself require every item to be classified', () => {
  // stockClassMap only matters to srv (which uses it to normalize raw ERP codes into
  // item.stockClass before calling engine-core) and to `when` conditions in this config's
  // own buildUp — engine-core itself has no opinion on it beyond that. An item with no
  // stockClass at all still prices normally as long as nothing in buildUp conditions on it.
  const config = europeConfig({ stockClassMap: { MTS: 'MTS', OMT: 'NonMTS' } });
  const facts = { costs: { 'P-1': { default: 'C1', candidates: [{ value: '100.00', currency: 'EUR', basis: 'MOVING_AVG', confidence: 'EXACT', source: { system: 'ERP', key: 'C1' } }] } }, elements: { 'P-1': { freight: '0', duty: '0', pickCharge: '0', molv: '0' } } };
  const request = { context: { purpose: 'INDICATIVE' }, items: [{ partNumber: 'P-1', quantity: 1 }] };
  const line = price({ request, facts, config }).items[0];
  assert.equal(line.status, 'PRICED');
  assert.equal(line.trace.stockClass, null);
});

test('buildUp elements conditioned on item.stockClass branch correctly, and the resolved value shows up in the trace', () => {
  const config = europeConfig({
    stockClassMap: { MTS: 'MTS', OMT: 'NonMTS' },
    buildUp: [
      { id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE },
      { id: 'MTS_ONLY_ADDER', type: 'ADDER', amount: 10, when: "item.stockClass === 'MTS'", provenance: HUMAN_PROVENANCE },
      { id: 'NONMTS_ONLY_ADDER', type: 'ADDER', amount: 25, when: "item.stockClass === 'NonMTS'", provenance: HUMAN_PROVENANCE },
    ],
    constraints: [],
  });
  const facts = { costs: { 'P-1': { default: 'C1', candidates: [{ value: '100.00', currency: 'EUR', basis: 'MOVING_AVG', confidence: 'EXACT', source: { system: 'ERP', key: 'C1' } }] } }, elements: {} };

  const mtsRequest = { context: { purpose: 'INDICATIVE' }, items: [{ partNumber: 'P-1', quantity: 1, stockClass: 'MTS' }] };
  const mtsLine = price({ request: mtsRequest, facts, config }).items[0];
  assert.equal(mtsLine.status, 'PRICED');
  assert.equal(mtsLine.result.unitPrice, '110'); // BASE 100 + MTS-only adder 10
  assert.equal(mtsLine.trace.stockClass, 'MTS');

  const nonMtsRequest = { context: { purpose: 'INDICATIVE' }, items: [{ partNumber: 'P-1', quantity: 1, stockClass: 'NonMTS' }] };
  const nonMtsLine = price({ request: nonMtsRequest, facts, config }).items[0];
  assert.equal(nonMtsLine.status, 'PRICED');
  assert.equal(nonMtsLine.result.unitPrice, '125'); // BASE 100 + NonMTS-only adder 25
  assert.equal(nonMtsLine.trace.stockClass, 'NonMTS');
});

test('item.stockClassError (srv could not resolve a raw ERP code) is a typed MISSING, never a silent skip', () => {
  const config = europeConfig({ stockClassMap: { MTS: 'MTS' } });
  const facts = { costs: { 'P-1': { default: 'C1', candidates: [{ value: '100.00', currency: 'EUR', basis: 'MOVING_AVG', confidence: 'EXACT', source: { system: 'ERP', key: 'C1' } }] } }, elements: {} };
  const request = { context: { purpose: 'INDICATIVE' }, items: [{ partNumber: 'P-1', quantity: 1, stockClassError: 'STOCK_CLASS_UNMAPPED:ZZZ' }] };

  const line = price({ request, facts, config }).items[0];
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'STOCK_CLASS_UNRESOLVED');
  assert.equal(line.missing.detail, 'STOCK_CLASS_UNMAPPED:ZZZ');
});
