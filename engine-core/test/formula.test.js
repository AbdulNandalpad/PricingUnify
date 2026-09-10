const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, evaluate, evaluateFormula, validateFormula, FormulaSyntaxError, FormulaInputError, FormulaEvalError } = require('../src/formula');

test('precedence and associativity: ^ binds tightest and is right-associative', () => {
  assert.equal(evaluateFormula('2 + 3 * 4 ^ 2', {}).value.toString(), '50');
  assert.equal(evaluateFormula('2 ^ 3 ^ 2', {}).value.toString(), '512');
  assert.equal(evaluateFormula('(2 + 3) * 4', {}).value.toString(), '20');
  assert.equal(evaluateFormula('-2 ^ 2', {}).value.toString(), '-4'); // conventional maths: -(2^2); write (-2)^2 for the other reading
});

test('dotted variables resolve into nested objects and are reported as used, as decimal strings', () => {
  const { value, used } = evaluateFormula('diameter_mm * cost.ptfe_rate_per_mm + cost.machining_setup / quantity', {
    diameter_mm: 137,
    quantity: 2,
    cost: { ptfe_rate_per_mm: '0.62', machining_setup: 180 },
  });
  assert.equal(value.toString(), '174.94');
  assert.deepEqual(used, { diameter_mm: '137', 'cost.ptfe_rate_per_mm': '0.62', 'cost.machining_setup': '180', quantity: '2' });
});

test('decimal exactness: 0.1 + 0.2 is 0.3, not a float artefact', () => {
  assert.equal(evaluateFormula('0.1 + 0.2', {}).value.toString(), '0.3');
});

test('functions: min, max, round, abs', () => {
  assert.equal(evaluateFormula('min(3, 1.5, 2)', {}).value.toString(), '1.5');
  assert.equal(evaluateFormula('max(a, 10)', { a: 12 }).value.toString(), '12');
  assert.equal(evaluateFormula('round(2.345, 2)', {}).value.toString(), '2.35');
  assert.equal(evaluateFormula('round(2.5)', {}).value.toString(), '3');
  assert.equal(evaluateFormula('abs(-4)', {}).value.toString(), '4');
});

test('a missing variable is a typed FormulaInputError naming the variable — never zero', () => {
  assert.throws(() => evaluateFormula('a * cost.rate', { a: 1, cost: {} }), (err) => err instanceof FormulaInputError && err.variable === 'cost.rate');
  assert.throws(() => evaluateFormula('a * b', { a: 1, b: null }), FormulaInputError);
});

test('syntax errors carry a position; unknown functions and stray tokens are rejected', () => {
  assert.throws(() => parse('2 +'), (e) => e instanceof FormulaSyntaxError && e.position === 3);
  assert.throws(() => parse('foo(1)'), FormulaSyntaxError);
  assert.throws(() => parse('2 $ 3'), FormulaSyntaxError);
  assert.throws(() => parse('(2 + 3'), FormulaSyntaxError);
  assert.throws(() => parse(''), FormulaSyntaxError);
  assert.throws(() => parse('round(1, 2, 3)'), FormulaSyntaxError);
});

test('no code injection surface: identifiers are looked up, never executed', () => {
  assert.throws(() => parse('process.exit()'), FormulaSyntaxError); // exit is not a known function
  const { used } = evaluate(parse('constructor'), { constructor: 5 });
  assert.deepEqual(used, { constructor: '5' });
  assert.throws(() => evaluateFormula('toString', {}), FormulaInputError); // prototype members are not values
});

test('division by zero is a typed evaluation error', () => {
  assert.throws(() => evaluateFormula('1 / (a - a)', { a: 3 }), FormulaEvalError);
});

test('validateFormula reports unknown variables against the available list without throwing', () => {
  assert.deepEqual(validateFormula('diameter_mm * cost.rate', ['diameter_mm', 'quantity', 'cost.rate']), { ok: true, variables: ['diameter_mm', 'cost.rate'], unknown: [], error: null });
  const bad = validateFormula('diameter_mm * cost.missing', ['diameter_mm']);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknown, ['cost.missing']);
  assert.equal(validateFormula('2 +').ok, false);
  assert.match(validateFormula('2 +').error, /Unexpected end/);
});
