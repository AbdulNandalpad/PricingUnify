const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigStore } = require('../src/store');
const { validateRegionRoute, validatePartyConfig, ConfigValidationError } = require('../src/validate');
const { HUMAN_PROVENANCE } = require('./fixtures');

function regionRoute(overrides = {}) {
  return {
    ood: 'SAP',
    salesOrg: '*',
    region: 'EUROPE',
    entityLabel: 'TSS Germany',
    version: '2026.08.0',
    status: 'ACTIVE',
    validFrom: '2026-08-01',
    validTo: null,
    provenance: HUMAN_PROVENANCE,
    ...overrides,
  };
}

function partyConfig(overrides = {}) {
  return {
    customerId: 'CUST-001',
    version: '2026.08.0',
    status: 'ACTIVE',
    validFrom: '2026-08-01',
    validTo: null,
    territory: 'DACH',
    customerCountry: 'DE',
    customerCurrency: 'EUR',
    customerOod: 'SAP',
    provenance: HUMAN_PROVENANCE,
    ...overrides,
  };
}

test('a well-formed region-route validates cleanly', () => {
  assert.equal(validateRegionRoute(regionRoute()), true);
});

test('region-route resolves ood+salesOrg to a region, falling back to the ood-wide "*" default', () => {
  const store = new ConfigStore();
  store.saveRegionRoute(regionRoute()); // SAP + '*' -> EUROPE
  store.saveRegionRoute(regionRoute({ ood: 'SMA', region: 'AMERICAS', entityLabel: 'TSS US Industrial' }));
  store.saveRegionRoute(regionRoute({ ood: 'CN', region: 'CHINA', entityLabel: 'TSS China' }));
  store.saveRegionRoute(regionRoute({ ood: 'IN', region: 'INDIA', entityLabel: 'TSS India' }));

  assert.equal(store.getEffectiveRegionRoute('SAP', 'DE01', '2026-08-15').region, 'EUROPE', 'falls back to the "*" default when DE01 has no route of its own');
  assert.equal(store.getEffectiveRegionRoute('SMA', '*', '2026-08-15').region, 'AMERICAS');
  assert.equal(store.getEffectiveRegionRoute('CN', '*', '2026-08-15').region, 'CHINA');
  assert.equal(store.getEffectiveRegionRoute('IN', '*', '2026-08-15').region, 'INDIA');
});

test('an unrecognized ood resolves to null, not a guess', () => {
  const store = new ConfigStore();
  store.saveRegionRoute(regionRoute());
  assert.equal(store.getEffectiveRegionRoute('ZZZ', '*', '2026-08-15'), null);
});

test('saveRegionRoute rejects an invalid document and never mutates the store', () => {
  const store = new ConfigStore();
  const bad = regionRoute({ validTo: '2020-01-01' }); // before validFrom
  assert.throws(() => store.saveRegionRoute(bad), ConfigValidationError);
  assert.equal(store.listRegionRouteVersions('SAP', '*').length, 0);
});

test('a well-formed party-config validates cleanly', () => {
  assert.equal(validatePartyConfig(partyConfig()), true);
});

test('party-config resolves by customerId, with no wildcard fallback', () => {
  const store = new ConfigStore();
  store.savePartyConfig(partyConfig());

  const found = store.getEffectivePartyConfig('CUST-001', '2026-08-15');
  assert.equal(found.customerOod, 'SAP');
  assert.equal(found.territory, 'DACH');

  assert.equal(store.getEffectivePartyConfig('CUST-999', '2026-08-15'), null, 'no default customer to fall back to');
});

test('party-config supersession closes the old window, same versioning rules as region-config', () => {
  const store = new ConfigStore();
  store.savePartyConfig(partyConfig({ customerOod: 'SAP' }));
  store.savePartyConfig(partyConfig({ version: '2026.09.0', validFrom: '2026-09-01', customerOod: 'SMA' }));

  assert.equal(store.getEffectivePartyConfig('CUST-001', '2026-08-15').customerOod, 'SAP');
  assert.equal(store.getEffectivePartyConfig('CUST-001', '2026-09-15').customerOod, 'SMA');
});
