const { test } = require('node:test');
const assert = require('node:assert/strict');
const { price, checkWhen } = require('../src/index');

/** Bad INPUT (a quantity, a cost, a fact) is a typed MISSING for that line — never an exception that
 *  fails the batch, never a negative or infinite price. Bad CONFIG (no basis, unknown type) still throws. */

const CONFIG = {
  region: 'T', version: 'v1', rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
  buildUp: [
    { id: 'BASE_COST', type: 'BASE' },
    { id: 'MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rateRef: 'markup' },
    { id: 'PICK', type: 'PER_LINE', amount: '20' },
  ],
  constraints: [],
};
const cost = (value, key = 'C1') => ({ default: key, candidates: [{ value, currency: 'EUR', basis: 'STANDARD', confidence: 'EXACT', source: { system: 'ERP', key } }] });
const run = (items, facts = {}) => price({
  request: { context: { purpose: 'INDICATIVE' }, items },
  facts: { costs: { A: cost('100'), B: cost('100') }, elements: { A: { markup: '0.1' }, B: { markup: '0.1' } }, ...facts },
  config: CONFIG,
}).items;

test('a missing, non-numeric, zero or negative quantity is MISSING(QUANTITY_INVALID) — and the next line still prices', () => {
  for (const quantity of [undefined, null, '', 'abc', 0, -5, '-1', NaN, Infinity]) {
    const [bad, good] = run([{ partNumber: 'A', quantity }, { partNumber: 'B', quantity: 10 }]);
    assert.equal(bad.status, 'MISSING', String(quantity));
    assert.equal(bad.missing.reason, 'QUANTITY_INVALID', String(quantity));
    assert.equal(good.status, 'PRICED', 'one bad line must not fail its neighbours');
  }
});

test('a numeric-string quantity is still fine', () => {
  assert.equal(run([{ partNumber: 'A', quantity: '10' }])[0].status, 'PRICED');
});

test('a non-numeric COST value is MISSING(COST_VALUE_INVALID), not a thrown DecimalError', () => {
  const [line] = run([{ partNumber: 'A', quantity: 1 }], { costs: { A: cost('n/a') } });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'COST_VALUE_INVALID');
});

test('a non-numeric FACT a step needs is MISSING(FACT_INVALID) naming the fact, not a thrown error', () => {
  const [line] = run([{ partNumber: 'A', quantity: 1 }], { elements: { A: { markup: 'ten percent' } } });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'FACT_INVALID');
  assert.match(line.missing.detail, /markup/);
});

test('config errors still refuse to run: a FACTOR without a basis throws', () => {
  const bad = { ...CONFIG, buildUp: [{ id: 'BASE_COST', type: 'BASE' }, { id: 'F', type: 'FACTOR', rate: 0.1 }] };
  assert.throws(() => price({ request: { context: {}, items: [{ partNumber: 'A', quantity: 1 }] }, facts: { costs: { A: cost('100') } }, config: bad }), /no declared basis/);
});

test('an explicit selectedCostId that matches nothing is MISSING(SELECTED_COST_NOT_FOUND), not another cost labelled USER', () => {
  const [line] = run([{ partNumber: 'A', quantity: 1, selectedCostId: 'NOPE' }]);
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'SELECTED_COST_NOT_FOUND');
});

test('a matching selectedCostId is still selectedBy USER', () => {
  const [line] = run([{ partNumber: 'A', quantity: 1, selectedCostId: 'C1' }]);
  assert.equal(line.trace.costCandidate.selectedBy, 'USER');
});

test('facts are looked up by the line key when one is given: the same part on two lines can carry different facts', () => {
  const facts = {
    costs: { A: cost('100'), L0: cost('100'), L1: cost('200') },
    elements: { A: { markup: '0' }, L0: { markup: '0.1' }, L1: { markup: '0.5' } },
  };
  const [one, two, plain] = run([
    { partNumber: 'A', quantity: 10, factsKey: 'L0' },
    { partNumber: 'A', quantity: 10, factsKey: 'L1' },
    { partNumber: 'A', quantity: 10 }, // no key -> part-number facts, exactly as before
  ], facts);
  assert.equal(one.result.unitPrice, '112'); // 100 + 10% + 20/10
  assert.equal(two.result.unitPrice, '302'); // 200 + 50% + 2
  assert.equal(plain.result.unitPrice, '102'); // 100 + 0% + 2
});

test('checkWhen accepts what the kernel evaluates and rejects what it cannot', () => {
  for (const ok of ["item.x === 'A'", 'item.n >= 3', 'item.c in A,B', ["item.x === 'A'", "item.y !== 'B'"]]) assert.equal(checkWhen(ok), null, JSON.stringify(ok));
  for (const bad of ['', '   ', 'whatever', 'item.x', [], ['ok === 1', 'nonsense'], 42, 'item.c in A,,B']) assert.ok(checkWhen(bad), JSON.stringify(bad));
});
