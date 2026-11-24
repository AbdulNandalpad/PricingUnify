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

test('listOodsForRegion returns the Origins of Data routed to a region (used to default a line\'s origin)', () => {
  const { ConfigStore } = require('../src/store');
  const store = new ConfigStore();
  const route = (ood, region) => ({ ood, salesOrg: '*', region, entityLabel: region, version: '2026.08.0', status: 'ACTIVE', validFrom: '2026-01-01', validTo: null, provenance: { source: 'HUMAN', authoredBy: 't@tss.example', authoredAt: '2026-08-01T00:00:00Z' } });
  store.saveRegionRoute(route('SAP', 'EUROPE'));
  store.saveRegionRoute(route('SMA', 'AMERICAS'));
  store.saveRegionRoute(route('SME', 'EUROPE'));
  assert.deepEqual(store.listOodsForRegion('AMERICAS', '2026-11-24'), ['SMA']);
  assert.deepEqual(store.listOodsForRegion('EUROPE', '2026-11-24').sort(), ['SAP', 'SME']); // ambiguous -> srv leaves the origin blank
  assert.deepEqual(store.listOodsForRegion('INDIA', '2026-11-24'), []);
});

test('defaultWarehouse is an optional non-empty string on region-config', () => {
  assert.equal(validateRegionConfig(europeConfig({ defaultWarehouse: '1020' })), true);
  assert.throws(() => validateRegionConfig(europeConfig({ defaultWarehouse: '' })));
});
