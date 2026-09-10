const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diff } = require('../src/diff');
const { ConfigStore } = require('../src/store');
const { europeConfig } = require('./fixtures');

test('identical documents diff to nothing', () => {
  assert.deepEqual(diff(europeConfig(), europeConfig()), []);
});

test('a changed nested value is one flat entry with a JSON-pointer path', () => {
  const a = europeConfig();
  const b = europeConfig({ buildUp: a.buildUp.map((el) => (el.id === 'SCM_MARKUP' ? { ...el, rate: 0.06 } : el)) });
  assert.deepEqual(diff(a, b), [{ path: '/buildUp/1/rate', from: 0.047, to: 0.06 }]);
});

test('added and removed values show the absent side as undefined; arrays compare by index so a reorder is a change', () => {
  const a = { sell: { defaultMargin: 0.3 }, rows: [{ part: 'A' }, { part: 'B' }] };
  const b = { sell: { defaultMargin: 0.3, rounding: { mode: 'HALF_UP', decimalPlaces: 2 } }, rows: [{ part: 'B' }] };
  const changes = diff(a, b);
  assert.deepEqual(changes, [
    { path: '/sell/rounding', from: undefined, to: { mode: 'HALF_UP', decimalPlaces: 2 } },
    { path: '/rows/0/part', from: 'A', to: 'B' },
    { path: '/rows/1', from: { part: 'B' }, to: undefined },
  ]);
});

test('null and 0 are different values, and so are "0.30" and 0.3 — the diff never coerces', () => {
  assert.deepEqual(diff({ a: null }, { a: 0 }), [{ path: '/a', from: null, to: 0 }]);
  assert.deepEqual(diff({ a: '0.30' }, { a: 0.3 }), [{ path: '/a', from: '0.30', to: 0.3 }]);
  assert.deepEqual(diff({ a: 1 }, { a: 1 }), []);
});

test('ignore drops a path and everything under it — version/status/provenance noise between two versions', () => {
  const a = europeConfig();
  const b = europeConfig({ version: '2026.09.0', status: 'DRAFT', provenance: { source: 'HUMAN', authoredBy: 'bob', authoredAt: '2026-09-01T00:00:00Z' } });
  assert.equal(diff(a, b).length, 4);
  assert.deepEqual(diff(a, b, { ignore: ['/version', '/status', '/provenance'] }), []);
});

test('keys containing "/" or "~" are escaped JSON-pointer style', () => {
  assert.deepEqual(diff({ 'a/b': { 'c~d': 1 } }, { 'a/b': { 'c~d': 2 } }), [{ path: '/a~1b/c~0d', from: 1, to: 2 }]);
});

test('ConfigStore.diff is the same function, usable on any two stored versions', () => {
  const store = new ConfigStore();
  const a = store.saveVersion(europeConfig());
  const b = store.saveVersion(europeConfig({ version: '2026.09.0', validFrom: '2026-09-01', rounding: { mode: 'HALF_EVEN', decimalPlaces: 2 } }));
  const changes = store.diff(a, b, { ignore: ['/version', '/status', '/supersedes', '/validFrom', '/validTo', '/provenance'] });
  assert.deepEqual(changes, [{ path: '/rounding/mode', from: 'HALF_UP', to: 'HALF_EVEN' }]);
});
