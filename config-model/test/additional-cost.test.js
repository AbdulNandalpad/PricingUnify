const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRegionConfig } = require('../src/validate');
const { europeConfig } = require('./fixtures');

test('additionalCostMap is a valid optional field on region-config', () => {
  const config = europeConfig({
    additionalCostMap: {
      0: { markup: false, landedCost: false, tariff: false, pick: false },
      1: { markup: true, landedCost: true, tariff: true, pick: true },
    },
  });
  assert.equal(validateRegionConfig(config), true);
});

test('additionalCostMap entries reject unknown keys', () => {
  const config = europeConfig({ additionalCostMap: { 0: { markup: false, notARealField: true } } });
  assert.throws(() => validateRegionConfig(config));
});
