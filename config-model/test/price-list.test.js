const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePriceList, validateDocument, ConfigValidationError } = require('../src/validate');
const { HUMAN_PROVENANCE } = require('./fixtures');

function book(overrides = {}) {
  return {
    id: 'EU_SEALS',
    name: 'EU standard seals',
    version: '2026.09.1',
    status: 'ACTIVE',
    supersedes: null,
    validFrom: '2026-09-01',
    validTo: null,
    currency: 'EUR',
    appliesWhen: { region: 'EUROPE', family: 'O-Rings' },
    dimensions: [
      { attr: 'customer', label: 'Customer', weight: 100 },
      { attr: 'tier', label: 'Tier', weight: 30 },
      { attr: 'region', label: 'Region', weight: 20 },
    ],
    rows: [
      { part: 'OR-25X3-NBR', match: {}, tiers: [{ from: 0, value: '1.20' }, { from: 500, value: '1.10' }, { from: 2000, value: '0.98' }], validFrom: '2026-01-01' },
      { part: 'OR-25X3-NBR', match: { tier: 'A' }, tiers: [{ from: 0, value: '1.08' }, { from: 500, value: '0.99' }], validFrom: '2026-01-01' },
      { part: 'OR-25X3-NBR', match: { customer: 'CUST-DE-001' }, tiers: [{ from: 0, value: '0.95' }], validFrom: '2026-07-01', validTo: '2026-12-31' },
    ],
    discount: [{ match: { tier: 'A' }, value: '0.03' }, { match: {}, value: 0 }],
    constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', min: 100, mode: 'PRICE', provenance: HUMAN_PROVENANCE }],
    provenance: HUMAN_PROVENANCE,
    ...overrides,
  };
}

function errorsOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigValidationError, `expected ConfigValidationError, got ${err}`);
    return Array.isArray(err.details) ? err.details.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))) : [];
  }
  assert.fail('expected validation to throw');
}

test('the engine-core techniques fixture shape validates as a price-list document', () => {
  assert.equal(validatePriceList(book()), true);
  assert.equal(validateDocument('price-list', book()), true);
});

test('a row matching on an undeclared dimension is rejected', () => {
  const errors = errorsOf(() => validatePriceList(book({ rows: [{ part: 'X', match: { salesOrg: 'DE01' }, tiers: [{ from: 0, value: '1' }] }] })));
  assert.ok(errors.some((e) => /undeclared dimension\(s\) salesOrg/.test(e)));
});

test('a discount rule matching on an undeclared dimension is rejected', () => {
  const errors = errorsOf(() => validatePriceList(book({ discount: [{ match: { channel: 'WEB' }, value: '0.1' }] })));
  assert.ok(errors.some((e) => /discount\[0\].*undeclared/.test(e)));
});

test('tiers must start at quantity 0', () => {
  const errors = errorsOf(() => validatePriceList(book({ rows: [{ part: 'X', match: {}, tiers: [{ from: 10, value: '1' }] }] })));
  assert.ok(errors.some((e) => /start at quantity 0/.test(e)));
});

test('tiers must strictly increase — equal or decreasing boundaries are rejected', () => {
  const equal = errorsOf(() => validatePriceList(book({ rows: [{ part: 'X', match: {}, tiers: [{ from: 0, value: '1' }, { from: 500, value: '0.9' }, { from: 500, value: '0.8' }] }] })));
  assert.ok(equal.some((e) => /strictly increase/.test(e)));
  const decreasing = errorsOf(() => validatePriceList(book({ rows: [{ part: 'X', match: {}, tiers: [{ from: 0, value: '1' }, { from: 500, value: '0.9' }, { from: 100, value: '0.8' }] }] })));
  assert.ok(decreasing.some((e) => /strictly increase/.test(e)));
});

test('two rows for the same part with identical match and overlapping validity are rejected — the engine could never choose', () => {
  const rows = [
    { part: 'X', match: { tier: 'A' }, tiers: [{ from: 0, value: '1' }], validFrom: '2026-01-01' },
    { part: 'X', match: { tier: 'A' }, tiers: [{ from: 0, value: '2' }], validFrom: '2026-06-01', validTo: '2026-12-31' },
  ];
  const errors = errorsOf(() => validatePriceList(book({ rows })));
  assert.ok(errors.some((e) => /rows\[0\] and rows\[1\].*overlapping validity/.test(e)));
});

test('the same part and match with NON-overlapping validity is fine — that is how a price change is scheduled', () => {
  const rows = [
    { part: 'X', match: { tier: 'A' }, tiers: [{ from: 0, value: '1' }], validFrom: '2026-01-01', validTo: '2026-06-01' },
    { part: 'X', match: { tier: 'A' }, tiers: [{ from: 0, value: '2' }], validFrom: '2026-07-01' },
  ];
  assert.equal(validatePriceList(book({ rows })), true);
});

test('the same part with a different match is fine — that is what specificity is for', () => {
  const rows = [
    { part: 'X', match: {}, tiers: [{ from: 0, value: '1' }] },
    { part: 'X', match: { tier: 'A' }, tiers: [{ from: 0, value: '0.9' }] },
    { part: 'X', match: { tier: 'A', region: 'EUROPE' }, tiers: [{ from: 0, value: '0.8' }] },
  ];
  assert.equal(validatePriceList(book({ rows })), true);
});

test('a row whose validTo precedes its validFrom is rejected', () => {
  const errors = errorsOf(() => validatePriceList(book({ rows: [{ part: 'X', match: {}, tiers: [{ from: 0, value: '1' }], validFrom: '2026-06-01', validTo: '2026-01-01' }] })));
  assert.ok(errors.some((e) => /rows\[0\] \(X\): validTo/.test(e)));
});

test('schema: required fields, closed object, status enum, 3-letter currency', () => {
  errorsOf(() => validatePriceList(book({ currency: 'EURO' })));
  errorsOf(() => validatePriceList(book({ status: 'LIVE' })));
  errorsOf(() => validatePriceList(book({ unknownField: 1 })));
  const { dimensions, ...noDimensions } = book();
  errorsOf(() => validatePriceList(noDimensions));
  errorsOf(() => validatePriceList(book({ rows: [{ part: 'X', tiers: [] }] })));
});

test('every status of the lifecycle is a valid document — DRAFT documents validate like ACTIVE ones', () => {
  for (const status of ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'REJECTED']) assert.equal(validatePriceList(book({ status })), true);
});
