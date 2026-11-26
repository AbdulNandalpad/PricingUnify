const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigStore } = require('../src/store');
const { validateRegionConfig, ConfigValidationError } = require('../src/validate');
const { europeConfig, HUMAN_PROVENANCE } = require('./fixtures');

/** ---- H2: a saved config must be something the kernel can actually run ---- */

function withExtra(el) { const c = europeConfig(); c.buildUp.push({ provenance: HUMAN_PROVENANCE, ...el }); return c; }
const details = (fn) => { try { fn(); } catch (e) { return JSON.stringify(e.details || e.message); } return null; };

test('an unparsable `when` is rejected at save time (it would fail every price call for the region)', () => {
  const bad = details(() => validateRegionConfig(withExtra({ id: 'X', type: 'ADDER', amount: '1', when: 'this is not valid' })));
  assert.ok(bad && /unsupported/.test(bad) && /this is not valid/.test(bad), bad);
});

test('an empty `when`, and an array containing a bad expression, are rejected', () => {
  assert.throws(() => validateRegionConfig(withExtra({ id: 'X', type: 'ADDER', amount: '1', when: '   ' })), ConfigValidationError);
  assert.throws(() => validateRegionConfig(withExtra({ id: 'X', type: 'ADDER', amount: '1', when: ["item.ood === 'SAP'", 'nonsense'] })), ConfigValidationError);
});

test('every `when` form the kernel supports still validates: ===, !==, >, `in` lists, AND-arrays', () => {
  for (const when of ["item.stockClass === 'NonMTS'", "item.ood !== 'IN'", 'item.quantity > 10', 'item.productCategory in PG,PH,PS', ["item.ood === 'SAP'", "item.supplier !== 'X'"]]) {
    assert.equal(validateRegionConfig(withExtra({ id: 'X', type: 'ADDER', amount: '1', when })), true, JSON.stringify(when));
  }
});

test('a bad `when` on a constraint or a margin rule is rejected too', () => {
  const c = europeConfig(); c.constraints[0].when = '???';
  assert.throws(() => validateRegionConfig(c), ConfigValidationError);
  const m = europeConfig({ marginRules: [{ id: 'M', marginPct: 30, when: '???', provenance: HUMAN_PROVENANCE }] });
  assert.throws(() => validateRegionConfig(m), ConfigValidationError);
});

test('a non-numeric rate / amount / min string is rejected (it would throw inside price())', () => {
  assert.throws(() => validateRegionConfig(withExtra({ id: 'F', type: 'FACTOR', basis: ['BASE_COST'], rate: 'abc' })), ConfigValidationError);
  assert.throws(() => validateRegionConfig(withExtra({ id: 'A', type: 'ADDER', amount: '1,5' })), ConfigValidationError);
  const c = europeConfig(); c.constraints[0].min = 'lots';
  assert.throws(() => validateRegionConfig(c), ConfigValidationError);
  assert.equal(validateRegionConfig(withExtra({ id: 'A', type: 'ADDER', amount: '-1.50' })), true); // negative decimals are legitimate (a discount)
});

test('a predefined margin must be at least 0 and below 100 (the kernel refuses anything else)', () => {
  for (const marginPct of [100, 120, -1, 'abc']) {
    assert.throws(() => validateRegionConfig(europeConfig({ marginRules: [{ id: 'M', marginPct, provenance: HUMAN_PROVENANCE }] })), ConfigValidationError, String(marginPct));
  }
  assert.equal(validateRegionConfig(europeConfig({ marginRules: [{ id: 'M', marginPct: '58', provenance: HUMAN_PROVENANCE }] })), true);
});

/** ---- H3: effective-dating ---- */

const save = (store, version, validFrom, extra = {}) => store.saveVersion(europeConfig({ version, validFrom, validTo: null, ...extra }));
const at = (store, date) => (store.getEffectiveAsOf('EUROPE', '*', date) || {}).version || null;

test('a BACKDATED save never inverts a window: the later version keeps its own start', () => {
  const store = new ConfigStore();
  save(store, 'v-sep', '2026-09-01');
  save(store, 'v-jun', '2026-06-01'); // backdated: starts BEFORE the existing one
  const sep = store.listVersions('EUROPE', '*').find((v) => v.version === 'v-sep');
  assert.equal(sep.status, 'ACTIVE', 'the later version is still in force');
  assert.equal(sep.validFrom, '2026-09-01');
  assert.ok(!sep.validTo || sep.validTo > sep.validFrom, `window must not be inverted (${sep.validFrom} -> ${sep.validTo})`);
  assert.equal(at(store, '2026-07-01'), 'v-jun');
  assert.equal(at(store, '2026-10-01'), 'v-sep');
  assert.equal(store.listVersions('EUROPE', '*').find((v) => v.version === 'v-jun').validTo, '2026-09-01', 'the backdated version stops where the next one starts');
});

test('the AMERICAS case from the review: backdating between two versions resolves each date to the right one', () => {
  const store = new ConfigStore();
  save(store, '2025.06.0', '2025-06-01');
  save(store, '2026.01.0', '2026-01-01');
  save(store, 'backdated', '2025-09-01');
  assert.equal(at(store, '2025-07-01'), '2025.06.0');
  assert.equal(at(store, '2025-10-01'), 'backdated');
  assert.equal(at(store, '2026-02-01'), '2026.01.0');
});

test('a DRAFT version is stored but never effective, and supersedes nothing', () => {
  const store = new ConfigStore();
  save(store, 'live', '2026-01-01');
  store.saveVersion(europeConfig({ version: 'draft-1', validFrom: '2026-03-01', status: 'DRAFT', validTo: null }));
  assert.equal(at(store, '2026-06-01'), 'live', 'the draft must not resolve');
  assert.equal(store.listVersions('EUROPE', '*').find((v) => v.version === 'live').status, 'ACTIVE');
  assert.equal(store.listVersions('EUROPE', '*').length, 2);
});

test('same-day re-save: the newer version wins and the replaced one has an empty window', () => {
  const store = new ConfigStore();
  save(store, 'first', '2026-04-01');
  save(store, 'second', '2026-04-01');
  assert.equal(at(store, '2026-04-02'), 'second');
  assert.equal(store.listVersions('EUROPE', '*').find((v) => v.version === 'first').status, 'SUPERSEDED');
});

test('future-dated save leaves today on the current version until the new start date', () => {
  const store = new ConfigStore();
  save(store, 'now', '2026-01-01');
  save(store, 'next-year', '2027-01-01');
  assert.equal(at(store, '2026-11-26'), 'now');
  assert.equal(at(store, '2027-01-01'), 'next-year');
});

test('no two versions ever cover the same date after any mix of saves', () => {
  const store = new ConfigStore();
  for (const [v, d] of [['a', '2026-05-01'], ['b', '2026-02-01'], ['c', '2026-08-01'], ['d', '2026-03-15'], ['e', '2026-05-01']]) save(store, v, d);
  const vs = store.listVersions('EUROPE', '*').filter((v) => v.status === 'ACTIVE' || v.status === 'SUPERSEDED');
  for (let day = Date.parse('2026-01-01'); day < Date.parse('2026-12-31'); day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    const covering = vs.filter((v) => v.validFrom <= date && (!v.validTo || date < v.validTo));
    assert.ok(covering.length <= 1, `${date} is covered by ${covering.map((v) => v.version)}`);
  }
});

test('a store holding ONLY a draft resolves nothing for any date', () => {
  const store = new ConfigStore();
  store.saveVersion(europeConfig({ version: 'draft-only', validFrom: '2026-01-01', status: 'DRAFT', validTo: null }));
  assert.equal(at(store, '2026-06-01'), null);
});
