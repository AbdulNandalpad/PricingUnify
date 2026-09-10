const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateCatalogBook, validateDocument, ConfigValidationError } = require('../src/validate');
const { HUMAN_PROVENANCE } = require('./fixtures');

function book(overrides = {}) {
  return {
    id: 'PTFE_BEARINGS',
    name: 'PTFE slide bearings',
    version: '2026.09.1',
    status: 'ACTIVE',
    supersedes: null,
    validFrom: '2026-09-01',
    validTo: null,
    currency: 'EUR',
    dsl_version: 1,
    appliesWhen: { family: 'PTFE bearings' },
    matchOn: ['spec', 'variant'],
    rows: [
      { match: { spec: '120', variant: 'standard' }, rate: '84.00' },
      { match: { spec: '160', variant: 'standard' }, rate: '112.00' },
    ],
    fallbackFormula: 'diameter_mm * cost.ptfe_rate_per_mm + cost.machining_setup / quantity',
    costInputs: {
      ptfe_rate_per_mm: { value: '0.62', unit: 'EUR / mm', validFrom: '2026-08-01', source: 'MANUAL' },
      machining_setup: [
        { value: '150', validFrom: '2026-01-01', validTo: '2026-06-01', source: 'MANUAL' },
        { value: '180', validFrom: '2026-06-01', source: 'MANUAL' },
      ],
    },
    freight: 0,
    margin: [{ match: { tier: 'A' }, value: '0.18' }, { match: {}, value: '0.22' }],
    floor: '0.12',
    discount: [{ match: { tier: 'A' }, value: '0.02' }, { match: {}, value: 0 }],
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

test('the engine-core techniques fixture shape validates as a catalog-book document', () => {
  assert.equal(validateCatalogBook(book()), true);
  assert.equal(validateDocument('catalog-book', book()), true);
});

test('fallbackFormula must parse with engine-core\'s formula DSL — a syntax error is named', () => {
  const errors = errorsOf(() => validateCatalogBook(book({ fallbackFormula: 'diameter_mm * (cost.ptfe_rate_per_mm' })));
  assert.ok(errors.some((e) => /fallbackFormula does not parse/.test(e)));
});

test('every cost.* the formula references must exist in costInputs', () => {
  const errors = errorsOf(() => validateCatalogBook(book({ fallbackFormula: 'diameter_mm * cost.ptfe_rate_per_mm + cost.packaging' })));
  assert.ok(errors.some((e) => /cost\.packaging/.test(e) && /costInputs has no such input/.test(e)));
});

test('a formula that only uses line attributes, quantity and declared cost inputs is fine; so is a book with no formula at all', () => {
  assert.equal(validateCatalogBook(book({ fallbackFormula: 'max(diameter_mm * cost.ptfe_rate_per_mm, 10) + round(cost.machining_setup / quantity)' })), true);
  assert.equal(validateCatalogBook(book({ fallbackFormula: null })), true);
});

test('rows must be unique on matchOn', () => {
  const rows = [{ match: { spec: '120', variant: 'standard' }, rate: '84.00' }, { match: { spec: '120', variant: 'standard' }, rate: '80.00' }];
  const errors = errorsOf(() => validateCatalogBook(book({ rows })));
  assert.ok(errors.some((e) => /rows\[0\] and rows\[1\] are the same spec=120, variant=standard/.test(e)));
});

test('a row that does not set every matchOn attribute could never match a part and is rejected', () => {
  const errors = errorsOf(() => validateCatalogBook(book({ rows: [{ match: { spec: '120' }, rate: '84.00' }] })));
  assert.ok(errors.some((e) => /does not set matchOn attribute\(s\) variant/.test(e)));
});

test('matchOn is configurable — rows are checked against the book\'s own attributes', () => {
  const rows = [{ match: { diameter_mm: 120 }, rate: '84.00' }, { match: { diameter_mm: 160 }, rate: '112.00' }];
  assert.equal(validateCatalogBook(book({ matchOn: ['diameter_mm'], rows })), true);
});

test('margin / discount rules must match on declared dimensions (defaults: customer, tier, region)', () => {
  const errors = errorsOf(() => validateCatalogBook(book({ margin: [{ match: { channel: 'OEM' }, value: '0.3' }] })));
  assert.ok(errors.some((e) => /margin\[0\].*undeclared dimension\(s\) channel/.test(e)));
  assert.equal(validateCatalogBook(book({ dimensions: [{ attr: 'channel', weight: 10 }], margin: [{ match: { channel: 'OEM' }, value: '0.3' }], discount: [] })), true);
});

test('floor is a fraction in [0, 1)', () => {
  errorsOf(() => validateCatalogBook(book({ floor: '1.2' })));
  errorsOf(() => validateCatalogBook(book({ floor: -0.1 })));
  assert.equal(validateCatalogBook(book({ floor: 0 })), true);
});

test('a cost input version with validTo before validFrom is rejected, and the input source is a closed enum', () => {
  const errors = errorsOf(() => validateCatalogBook(book({ costInputs: { ...book().costInputs, machining_setup: [{ value: '150', validFrom: '2026-06-01', validTo: '2026-01-01', source: 'MANUAL' }] } })));
  assert.ok(errors.some((e) => /costInputs\.machining_setup\[0\]/.test(e)));
  errorsOf(() => validateCatalogBook(book({ costInputs: { ptfe_rate_per_mm: { value: '0.62', source: 'GUESS' } } })));
});

test('schema: dsl_version is pinned to 1 and the document is a closed object', () => {
  errorsOf(() => validateCatalogBook(book({ dsl_version: 2 })));
  errorsOf(() => validateCatalogBook(book({ extra: true })));
  const { dsl_version, ...noVersion } = book();
  errorsOf(() => validateCatalogBook(noVersion));
});
