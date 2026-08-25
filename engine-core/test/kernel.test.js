const { test } = require('node:test');
const assert = require('node:assert/strict');
const { price } = require('../src/index');
const { CONFIDENCE, PURPOSE } = require('../src/cost');

/** Synthetic Europe-shaped config, not real TSS data — mirrors the deck's build-up
 *  (BASE moving-avg cost, SCM 4.7% factor, freight/duty adders, pick-charge per line,
 *  MOLV floor) for engine-core testing only. Real rates come later via config-model + golden tests. */
const EUROPE_CONFIG = {
  region: 'EUROPE',
  version: '2026.08.0',
  buildUp: [
    { id: 'BASE_COST', type: 'BASE' },
    { id: 'SCM_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.047 },
    { id: 'FREIGHT', type: 'ADDER', amountRef: 'freight' },
    { id: 'DUTY', type: 'ADDER', amountRef: 'duty' },
    { id: 'PICK_CHARGE', type: 'PER_LINE', amountRef: 'pickCharge' },
  ],
  constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv' }],
  rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
};

function baseRequest(overrides = {}) {
  return {
    context: { hostSystem: 'API', hostObjectType: 'QUOTE', purpose: PURPOSE.INDICATIVE, ...overrides.context },
    items: overrides.items || [{ partNumber: 'P-100', quantity: 10 }],
  };
}

function baseFacts(overrides = {}) {
  return {
    costs: {
      'P-100': {
        default: 'MOVING_AVG_1',
        candidates: [
          {
            value: '100.00', currency: 'EUR', basis: 'MOVING_AVG',
            source: { system: 'S4', table: 'MBEW', field: 'VERPR', key: 'MOVING_AVG_1' },
            validFrom: '2026-08-01', retrievedAt: '2026-08-20T00:00:00Z', confidence: CONFIDENCE.EXACT,
          },
        ],
      },
    },
    elements: { 'P-100': { freight: '5.00', duty: '2.00', pickCharge: '21.00', molv: '50.00' } },
    ...overrides,
  };
}

test('prices a line through BASE, FACTOR, ADDER, PER_LINE with a full trace', () => {
  const result = price({ request: baseRequest(), facts: baseFacts(), config: EUROPE_CONFIG });
  const [line] = result.items;

  // 100 + 100*0.047(=4.70) + 5.00 + 2.00 + 21.00/10(=2.10) = 113.80
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '113.8');
  assert.equal(line.result.currency, 'EUR');
  assert.equal(line.trace.steps.length, 5);
  assert.equal(line.trace.costCandidate.confidence, 'EXACT');
  assert.equal(line.trace.costCandidate.selectedBy, 'DEFAULT');
});

test('MOLV floor constraint lifts the unit price when the line total falls short', () => {
  const facts = baseFacts();
  facts.elements['P-100'].molv = '2000.00'; // well above the natural line total
  const result = price({ request: baseRequest(), facts, config: EUROPE_CONFIG });
  const [line] = result.items;

  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '200'); // 2000 / qty(10)
  assert.equal(line.trace.constraintPasses.length, 1);
  assert.equal(line.trace.constraintPasses[0].kind, 'FLOOR');
});

test('a missing cost candidate is a typed MISSING outcome, not a thrown exception', () => {
  const request = baseRequest({ items: [{ partNumber: 'UNKNOWN', quantity: 1 }] });
  const result = price({ request, facts: baseFacts(), config: EUROPE_CONFIG });
  const [line] = result.items;

  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'NO_CANDIDATES');
  assert.equal(line.result, undefined);
});

test('BINDING purpose blocks a STALE cost candidate without an explicit override', () => {
  const facts = baseFacts();
  facts.costs['P-100'].candidates[0].confidence = CONFIDENCE.STALE;
  const request = baseRequest({ context: { purpose: PURPOSE.BINDING } });

  const blocked = price({ request, facts, config: EUROPE_CONFIG }).items[0];
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.missing.reason, 'CONFIDENCE_BLOCKED_BY_PURPOSE');

  const overriddenRequest = baseRequest({
    context: { purpose: PURPOSE.BINDING },
    items: [{ partNumber: 'P-100', quantity: 10, overrideStaleCost: true }],
  });
  const overridden = price({ request: overriddenRequest, facts, config: EUROPE_CONFIG }).items[0];
  assert.equal(overridden.status, 'PRICED');
});

test('a FACTOR without a declared basis makes the engine refuse to run', () => {
  const badConfig = {
    ...EUROPE_CONFIG,
    buildUp: [{ id: 'BASE_COST', type: 'BASE' }, { id: 'BAD_FACTOR', type: 'FACTOR', rate: 0.1 }],
  };
  assert.throws(
    () => price({ request: baseRequest(), facts: baseFacts(), config: badConfig }),
    /basis/,
  );
});

test('decimal math has no floating-point drift', () => {
  const config = {
    region: 'EUROPE', version: '2026.08.0',
    buildUp: [{ id: 'BASE_COST', type: 'BASE' }, { id: 'SCM_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.1 }],
  };
  const facts = {
    costs: { 'P-1': { default: 'M', candidates: [{ value: '0.1', currency: 'EUR', confidence: CONFIDENCE.EXACT, source: { key: 'M' } }] } },
    elements: {},
  };
  const request = baseRequest({ items: [{ partNumber: 'P-1', quantity: 1 }] });
  const line = price({ request, facts, config }).items[0];
  assert.equal(line.result.unitPrice, '0.11'); // 0.1 + 0.1*0.1 — would be 0.10999999999999999 in IEEE754 float
});
