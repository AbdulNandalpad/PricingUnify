const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRegionConfig, ConfigValidationError } = require('../src/validate');
const { europeConfig, HUMAN_PROVENANCE } = require('./fixtures');

test('a well-formed region config validates cleanly', () => {
  assert.equal(validateRegionConfig(europeConfig()), true);
});

test('a FACTOR without a basis is rejected', () => {
  const config = europeConfig();
  delete config.buildUp[1].basis;
  assert.throws(() => validateRegionConfig(config), ConfigValidationError);
});

test('a FACTOR basis referencing an unknown step id is rejected', () => {
  const config = europeConfig();
  config.buildUp[1].basis = ['NOT_A_REAL_STEP'];
  assert.throws(() => validateRegionConfig(config), (err) => {
    assert.ok(err instanceof ConfigValidationError);
    assert.ok(err.details.some((d) => d.includes('NOT_A_REAL_STEP')));
    return true;
  });
});

test('a FACTOR basis referencing a later step is rejected (forward references are not allowed)', () => {
  const config = europeConfig();
  config.buildUp[1].basis = ['FREIGHT'];
  assert.throws(() => validateRegionConfig(config), ConfigValidationError);
});

test('duplicate element ids across buildUp and constraints are rejected', () => {
  const config = europeConfig();
  config.constraints[0].id = 'BASE_COST';
  assert.throws(() => validateRegionConfig(config), ConfigValidationError);
});

test('a buildUp with no BASE element is rejected', () => {
  const config = europeConfig({ buildUp: europeConfig().buildUp.filter((el) => el.type !== 'BASE') });
  assert.throws(() => validateRegionConfig(config), ConfigValidationError);
});

test('validTo before validFrom is rejected', () => {
  const config = europeConfig({ validTo: '2026-01-01' });
  assert.throws(() => validateRegionConfig(config), ConfigValidationError);
});

test('an unknown top-level field is rejected (schema is closed, not just documentation)', () => {
  const config = europeConfig({ hardcodedMarkup: 0.05 });
  assert.throws(() => validateRegionConfig(config), ConfigValidationError);
});

test('every entity requires provenance', () => {
  const config = europeConfig();
  delete config.buildUp[0].provenance;
  assert.throws(() => validateRegionConfig(config), ConfigValidationError);
});

test('CONSTRAINT elements do not belong in buildUp (kernel applies them separately)', () => {
  const config = europeConfig();
  config.buildUp.push({ id: 'STRAY_CONSTRAINT', type: 'CONSTRAINT', kind: 'FLOOR', provenance: HUMAN_PROVENANCE });
  assert.throws(() => validateRegionConfig(config), ConfigValidationError);
});
