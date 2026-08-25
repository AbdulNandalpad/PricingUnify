const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigStore } = require('../src/store');
const { ConfigValidationError } = require('../src/validate');
const { europeConfig } = require('./fixtures');

test('saveVersion rejects an invalid config and never mutates the store', () => {
  const store = new ConfigStore();
  const bad = europeConfig();
  delete bad.buildUp[1].basis;
  assert.throws(() => store.saveVersion(bad), ConfigValidationError);
  assert.equal(store.listVersions('EUROPE').length, 0);
});

test('saving a new ACTIVE version supersedes the previous one', () => {
  const store = new ConfigStore();
  store.saveVersion(europeConfig());
  store.saveVersion(europeConfig({ version: '2026.09.0', validFrom: '2026-09-01' }));

  const versions = store.listVersions('EUROPE');
  assert.equal(versions.length, 2);
  assert.equal(versions.find((v) => v.version === '2026.08.0').status, 'SUPERSEDED');
  assert.equal(versions.find((v) => v.version === '2026.09.0').status, 'ACTIVE');
});

test('getEffectiveAsOf reprices historical dates against the version that was live then', () => {
  const store = new ConfigStore();
  store.saveVersion(europeConfig({ version: '2026.08.0', validFrom: '2026-08-01', validTo: '2026-09-01' }));
  store.saveVersion(europeConfig({ version: '2026.09.0', validFrom: '2026-09-01', validTo: null }));

  assert.equal(store.getEffectiveAsOf('EUROPE', '2026-08-15').version, '2026.08.0');
  assert.equal(store.getEffectiveAsOf('EUROPE', '2026-09-15').version, '2026.09.0');
  assert.equal(store.getEffectiveAsOf('EUROPE', '2025-01-01'), null);
});

test('cannot save two versions with the same version id for a region', () => {
  const store = new ConfigStore();
  store.saveVersion(europeConfig());
  assert.throws(() => store.saveVersion(europeConfig()), ConfigValidationError);
});
