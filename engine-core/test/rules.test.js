const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRows, tierValue, specificity } = require('../src/rules');

const DIMS = [{ attr: 'customer', weight: 100 }, { attr: 'tier', weight: 30 }, { attr: 'region', weight: 20 }];
const ROWS = [
  { id: 'default', match: {}, value: 1 },
  { id: 'tierA', match: { tier: 'A' }, value: 2 },
  { id: 'cust', match: { customer: 'C1' }, value: 3, validFrom: '2026-07-01', validTo: '2026-12-31' },
  { id: 'tierA-eu', match: { tier: 'A', region: 'EUROPE' }, value: 4 },
];

test('most specific row wins; every candidate reports its fate', () => {
  const res = resolveRows(ROWS, { customer: 'C1', tier: 'A', region: 'EUROPE' }, DIMS, '2026-09-10');
  assert.equal(res.winner.row.id, 'cust');
  assert.equal(res.ambiguous, false);
  const byId = Object.fromEntries(res.candidates.map((c) => [c.row.id, c]));
  assert.equal(byId.cust.won, true);
  assert.equal(byId['tierA-eu'].reason, 'LESS_SPECIFIC:50<100');
  assert.equal(byId.default.specificity, 0);
});

test('validity is checked against the price date', () => {
  const res = resolveRows(ROWS, { customer: 'C1', tier: 'A', region: 'EUROPE' }, DIMS, '2027-01-15');
  assert.equal(res.winner.row.id, 'tierA-eu');
  assert.equal(res.candidates.find((c) => c.row.id === 'cust').reason, 'OUTSIDE_VALIDITY');
});

test('an unmatched context falls back to the default row; no default means no winner', () => {
  assert.equal(resolveRows(ROWS, { tier: 'B' }, DIMS, '2026-09-10').winner.row.id, 'default');
  assert.equal(resolveRows(ROWS.slice(1), { tier: 'B' }, DIMS, '2026-09-10').winner, null);
});

test('equal specificity between two live rows is AMBIGUOUS, never decided by array order', () => {
  const rows = [{ id: 'a', match: { tier: 'A' } }, { id: 'b', match: { region: 'X' } }];
  const dims = [{ attr: 'tier', weight: 10 }, { attr: 'region', weight: 10 }];
  const res = resolveRows(rows, { tier: 'A', region: 'X' }, dims, '2026-09-10');
  assert.equal(res.ambiguous, true);
  assert.equal(res.winner, null);
  assert.ok(res.candidates.every((c) => c.reason === 'AMBIGUOUS'));
});

test('an undeclared dimension still counts (weight 1) so it never silently ties with the default', () => {
  assert.equal(specificity({ colour: 'red' }, DIMS), 1);
});

test('tiers pick the highest from <= quantity; below the first tier is null', () => {
  const tiers = [{ from: 0, value: '1.20' }, { from: 500, value: '1.10' }, { from: 2000, value: '0.98' }];
  assert.equal(tierValue(tiers, 499).value, '1.20');
  assert.equal(tierValue(tiers, 500).value, '1.10');
  assert.equal(tierValue(tiers, 5000).value, '0.98');
  assert.equal(tierValue([{ from: 10, value: 1 }], 5), null);
});
