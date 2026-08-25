/** The 5 element primitives. See requirements §5.1.
 *  BASE | FACTOR (basis REQUIRED) | ADDER | PER_LINE | CONSTRAINT
 *  MROQ is routing input, NOT a constraint. COMPOSITE factors tagged allocatable:false. */
const Decimal = require('decimal.js');

const ELEMENT_TYPES = Object.freeze(['BASE', 'FACTOR', 'ADDER', 'PER_LINE', 'CONSTRAINT']);

function readPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** A literal `amount`/`rate`/`min`/`step` in config wins; a `*Ref` pulls the value from facts.elements. */
function resolveParam(el, literalKey, refKey, facts) {
  if (el[literalKey] !== undefined) return { value: new Decimal(el[literalKey]), source: 'CONFIG' };
  if (el[refKey]) {
    const raw = readPath(facts && facts.elements, el[refKey]);
    if (raw === undefined || raw === null) return { value: null, source: el[refKey] };
    return { value: new Decimal(raw), source: el[refKey] };
  }
  return { value: null, source: null };
}

function sumBasis(basisIds, stepValues, elementId) {
  if (!Array.isArray(basisIds) || basisIds.length === 0) {
    throw new Error(`FACTOR "${elementId}" has no declared basis — engine refuses to run. See requirements §5.1.`);
  }
  return basisIds.reduce((sum, id) => {
    if (!Object.prototype.hasOwnProperty.call(stepValues, id)) {
      throw new Error(`FACTOR "${elementId}" basis references unknown step "${id}".`);
    }
    return sum.plus(stepValues[id]);
  }, new Decimal(0));
}

function applyBase(el, ctx) {
  const value = ctx.baseCost;
  return { delta: value, note: { basis: null, rate: null } };
}

function applyFactor(el, ctx) {
  const basisAmount = sumBasis(el.basis, ctx.stepValues, el.id);
  const { value: rate, source } = resolveParam(el, 'rate', 'rateRef', ctx.facts);
  if (rate === null) {
    return { delta: null, missing: { element: el.id, reason: 'RATE_MISSING', from: source } };
  }
  const delta = basisAmount.times(rate);
  return { delta, note: { basis: el.basis, basisAmount: basisAmount.toString(), rate: rate.toString() } };
}

function applyAdder(el, ctx) {
  const { value, source } = resolveParam(el, 'amount', 'amountRef', ctx.facts);
  if (value === null) {
    return { delta: null, missing: { element: el.id, reason: 'AMOUNT_MISSING', from: source } };
  }
  return { delta: value, note: { source } };
}

function applyPerLine(el, ctx) {
  const { value, source } = resolveParam(el, 'amount', 'amountRef', ctx.facts);
  if (value === null) {
    return { delta: null, missing: { element: el.id, reason: 'AMOUNT_MISSING', from: source } };
  }
  const quantity = new Decimal(ctx.quantity);
  if (quantity.isZero()) {
    return { delta: null, missing: { element: el.id, reason: 'QUANTITY_ZERO' } };
  }
  const delta = value.div(quantity);
  return { delta, note: { source, perQuantity: ctx.quantity } };
}

/** CONSTRAINT does not add to the build-up; it adjusts the running total in place (floor/step). */
function applyConstraint(el, running, ctx) {
  if (el.kind === 'FLOOR') {
    const { value: min } = resolveParam(el, 'min', 'minRef', ctx.facts);
    if (min === null) return { total: running, applied: false };
    const lineTotal = running.times(ctx.quantity);
    if (lineTotal.gte(min)) return { total: running, applied: false };
    const adjusted = min.div(ctx.quantity);
    return { total: adjusted, applied: true, note: { kind: 'FLOOR', min: min.toString(), from: lineTotal.toString() } };
  }
  if (el.kind === 'STEP') {
    const { value: step } = resolveParam(el, 'step', 'stepRef', ctx.facts);
    if (step === null || step.isZero()) return { total: running, applied: false };
    const steps = running.div(step).ceil();
    const adjusted = steps.times(step);
    if (adjusted.eq(running)) return { total: running, applied: false };
    return { total: adjusted, applied: true, note: { kind: 'STEP', step: step.toString() } };
  }
  if (el.kind === 'MIN_QTY') {
    const { value: minQty } = resolveParam(el, 'min', 'minRef', ctx.facts);
    if (minQty === null) return { total: running, applied: false };
    const quantity = new Decimal(ctx.quantity);
    if (quantity.gte(minQty)) return { total: running, applied: false };
    // Informational only — MOQ never silently changes price (mirrors MROQ being routing
    // input, not a price adjustment, per requirements §5.1). It still surfaces in the
    // trace so a BINDING caller can decide what to do about it.
    return {
      total: running,
      applied: true,
      note: { kind: 'MIN_QTY', min: minQty.toString(), quantity: quantity.toString(), warning: 'Requested quantity is below the minimum order quantity.' },
    };
  }
  throw new Error(`CONSTRAINT "${el.id}" has unknown kind "${el.kind}".`);
}

module.exports = { ELEMENT_TYPES, applyBase, applyFactor, applyAdder, applyPerLine, applyConstraint, readPath };
