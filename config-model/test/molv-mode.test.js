const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRegionConfig, ConfigValidationError } = require('../src/validate');
const { europeConfig, HUMAN_PROVENANCE } = require('./fixtures');
const { price } = require('@tss-pricing/engine-core');

test('mode is a valid optional field on a FLOOR constraint', () => {
  const config = europeConfig({
    constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv', mode: 'QUANTITY', provenance: HUMAN_PROVENANCE }],
  });
  assert.equal(validateRegionConfig(config), true);
});

test('mode rejects a value outside PRICE/QUANTITY', () => {
  const config = europeConfig({
    constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv', mode: 'SOMETHING_ELSE', provenance: HUMAN_PROVENANCE }],
  });
  assert.throws(() => validateRegionConfig(config), ConfigValidationError);
});

test('a config-model-authored QUANTITY-mode MOLV constraint drives an actual quantity bump through engine-core', () => {
  const config = europeConfig({
    buildUp: [{ id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE }],
    constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv', mode: 'QUANTITY', provenance: HUMAN_PROVENANCE }],
  });
  const facts = { costs: { 'P-1': { default: 'C', candidates: [{ value: '100.00', currency: 'EUR', confidence: 'EXACT', source: { key: 'C' } }] } }, elements: { 'P-1': { molv: '450.00' } } };
  const request = { context: { purpose: 'INDICATIVE' }, items: [{ partNumber: 'P-1', quantity: 1 }] };

  const line = price({ request, facts, config }).items[0];
  assert.equal(line.result.unitPrice, '100'); // price stays put
  assert.equal(line.result.quantity, 5); // ceil(450 / 100)
});
