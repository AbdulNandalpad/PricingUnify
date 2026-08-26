const { test } = require('node:test');
const assert = require('node:assert/strict');
const { price } = require('../src/index');
const { CONFIDENCE, PURPOSE } = require('../src/cost');

/**
 * TSS's cost access sequence — not SAP's condition technique. An ordered list of source
 * systems to try when a part has cost candidates from more than one: C4C manual entry
 * first, then ERP, then CCD, then CCP. The first system in the sequence with a candidate
 * wins; explicit user selection still overrides everything (see kernel.js).
 */
const CONFIG = {
  region: 'EUROPE',
  version: '2026.08.0',
  costAccessSequence: ['C4C', 'ERP', 'CCD', 'CCP'],
  buildUp: [{ id: 'BASE_COST', type: 'BASE' }],
  rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
};

function candidate(system, value, overrides = {}) {
  return {
    value, currency: 'EUR', basis: 'MOVING_AVG',
    source: { system, table: 't', field: 'f', key: `${system}_1` },
    validFrom: '2026-08-01', retrievedAt: '2026-08-20T00:00:00Z', confidence: CONFIDENCE.EXACT,
    ...overrides,
  };
}

function priceOne(candidates, itemOverrides = {}) {
  const request = {
    context: { purpose: PURPOSE.INDICATIVE },
    items: [{ partNumber: 'P-1', quantity: 1, ...itemOverrides }],
  };
  const facts = { costs: { 'P-1': { default: candidates[0]?.source.key, candidates } }, elements: {} };
  return price({ request, facts, config: CONFIG }).items[0];
}

test('the access sequence picks C4C manual cost when present, even though ERP is also available', () => {
  const line = priceOne([candidate('ERP', '100.00'), candidate('C4C', '95.00')]);
  assert.equal(line.result.unitPrice, '95');
  assert.equal(line.trace.costCandidate.source.system, 'C4C');
  assert.equal(line.trace.costCandidate.selectedBy, 'ACCESS_SEQUENCE:C4C');
});

test('falls through to ERP when there is no C4C manual cost', () => {
  const line = priceOne([candidate('CCD', '80.00'), candidate('ERP', '100.00')]);
  assert.equal(line.result.unitPrice, '100');
  assert.equal(line.trace.costCandidate.source.system, 'ERP');
  assert.equal(line.trace.costCandidate.selectedBy, 'ACCESS_SEQUENCE:ERP');
});

test('falls all the way through to CCP when nothing earlier in the sequence is available', () => {
  const line = priceOne([candidate('CCP', '42.00')]);
  assert.equal(line.result.unitPrice, '42');
  assert.equal(line.trace.costCandidate.selectedBy, 'ACCESS_SEQUENCE:CCP');
});

test('a candidate from a system outside the access sequence is never picked over one that is in it', () => {
  const line = priceOne([candidate('SOME_OTHER_SYSTEM', '1.00'), candidate('CCD', '80.00')]);
  assert.equal(line.result.unitPrice, '80');
  assert.equal(line.trace.costCandidate.source.system, 'CCD');
});

test('an explicit user selection still overrides the access sequence', () => {
  const line = priceOne(
    [candidate('C4C', '95.00'), candidate('ERP', '100.00')],
    { selectedCostId: 'ERP_1' },
  );
  assert.equal(line.result.unitPrice, '100');
  assert.equal(line.trace.costCandidate.selectedBy, 'USER');
});

test('costAccessSequence can be keyed by stock class -- Non-MTS parts try CCD first, everything else keeps the original order', () => {
  const stockClassAwareConfig = {
    ...CONFIG,
    costAccessSequence: {
      NonMTS: ['CCD', 'C4C', 'ERP', 'CCP'],
      '*': ['C4C', 'ERP', 'CCD', 'CCP'],
    },
  };
  const priceWith = (stockClass) => {
    const request = { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'P-1', quantity: 1, ...(stockClass ? { stockClass } : {}) }] };
    const candidates = [candidate('ERP', '100.00'), candidate('CCD', '80.00')];
    const facts = { costs: { 'P-1': { default: 'ERP_1', candidates } }, elements: {} };
    return price({ request, facts, config: stockClassAwareConfig }).items[0];
  };

  const nonMts = priceWith('NonMTS');
  assert.equal(nonMts.trace.costCandidate.source.system, 'CCD');
  assert.equal(nonMts.trace.costCandidate.selectedBy, 'ACCESS_SEQUENCE:CCD');

  const mts = priceWith('MTS'); // not a key in the map -- falls back to '*'
  assert.equal(mts.trace.costCandidate.source.system, 'ERP');
  assert.equal(mts.trace.costCandidate.selectedBy, 'ACCESS_SEQUENCE:ERP');

  const unclassified = priceWith(undefined); // no stock class at all -- also falls back to '*'
  assert.equal(unclassified.trace.costCandidate.source.system, 'ERP');
});

test('with no costAccessSequence configured, resolution is unchanged (falls back to default/first candidate)', () => {
  const configWithoutSequence = { ...CONFIG, costAccessSequence: undefined };
  const request = { context: { purpose: PURPOSE.INDICATIVE }, items: [{ partNumber: 'P-1', quantity: 1 }] };
  const candidates = [candidate('ERP', '100.00'), candidate('C4C', '95.00')];
  const facts = { costs: { 'P-1': { default: 'C4C_1', candidates } }, elements: {} };
  const line = price({ request, facts, config: configWithoutSequence }).items[0];
  assert.equal(line.result.unitPrice, '95'); // picks `default` (C4C_1), same behavior as before access sequences existed
  assert.equal(line.trace.costCandidate.selectedBy, 'DEFAULT');
});
