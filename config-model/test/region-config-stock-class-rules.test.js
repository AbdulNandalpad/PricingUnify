const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRegionConfig } = require('../src/validate');
const { europeConfig } = require('./fixtures');

test('stockClassRules is optional, validates its shape, and rejects an unknown class or a missing default', () => {
  assert.equal(validateRegionConfig(europeConfig()), true);
  const ok = europeConfig({ stockClassRules: { rules: [{ ood: 'SAP', strategyCode: 'Z4', stockClass: 'MTS' }], default: 'NonMTS' } });
  assert.equal(validateRegionConfig(ok), true);
  assert.throws(() => validateRegionConfig(europeConfig({ stockClassRules: { rules: [{ ood: 'SAP', strategyCode: 'Z4', stockClass: 'MTO' }], default: 'NonMTS' } })));
  assert.throws(() => validateRegionConfig(europeConfig({ stockClassRules: { rules: [] } })));
});
