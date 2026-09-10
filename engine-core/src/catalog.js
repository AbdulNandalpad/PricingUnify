/** Catalog + formula technique (ARCHITECTURE_V2 §2.7): a negotiated SELL rate where an exact
 *  catalog row exists for the part's spec; otherwise a COST built by the book's fallback
 *  formula from the line's own attributes and the book's effective-dated cost inputs, then
 *  freight, margin, discount, and a margin-floor check. Never a silent zero: a size with
 *  no row and a formula input with no value in force are both typed MISSING. */
const Decimal = require('decimal.js');
const { resolveRows, describeMatch } = require('./rules');
const { parse, evaluate, FormulaInputError, FormulaEvalError, FormulaSyntaxError } = require('./formula');
const { purposeAllows, CONFIDENCE, PURPOSE } = require('./cost');
const { roundTo } = require('./rounding');
const { summarizeResolution } = require('./priceList');
const trace = require('./trace');

const DEFAULT_ROUNDING = { mode: 'HALF_UP', decimalPlaces: 2 };
const DEFAULT_MATCH_ON = ['spec', 'variant'];
const DEFAULT_DIMENSIONS = [
  { attr: 'customer', label: 'Customer', weight: 100 },
  { attr: 'tier', label: 'Tier', weight: 30 },
  { attr: 'region', label: 'Region', weight: 20 },
];

function missingLine(item, book, reason, detail, extra = {}) {
  return {
    partNumber: item.partNumber,
    status: 'MISSING',
    missing: { reason, detail },
    trace: { technique: 'CATALOG_FORMULA', book: book.id, bookVersion: book.version, steps: [], ...extra },
  };
}

/** The cost input value in force on the pricing date, with its provenance for the trace. */
function costInputsInForce(costInputs, date) {
  const values = {};
  const provenance = {};
  for (const [name, input] of Object.entries(costInputs || {})) {
    const versions = Array.isArray(input) ? input : [input];
    const inForce = versions.find((v) => (!v.validFrom || v.validFrom <= date) && (!v.validTo || date < v.validTo));
    if (!inForce) continue;
    values[name] = inForce.value;
    provenance[name] = { value: String(inForce.value), unit: inForce.unit || null, validFrom: inForce.validFrom || null, validTo: inForce.validTo || null, source: inForce.source || 'MANUAL', confidence: inForce.confidence || (inForce.source === 'AI_DERIVED' ? CONFIDENCE.FALLBACK : CONFIDENCE.EXACT) };
  }
  return { values, provenance };
}

function priceCatalogItem(item, product, book, ctx) {
  const quantity = Number(item.quantity);
  const attrs = { ...product, customer: ctx.customerId, tier: ctx.tier, region: ctx.region, salesOrg: ctx.salesOrg };
  const dimensions = book.dimensions || DEFAULT_DIMENSIONS;
  const matchOn = book.matchOn || DEFAULT_MATCH_ON;
  const rounding = book.rounding || DEFAULT_ROUNDING;

  const checked = (book.rows || []).map((row, index) => {
    const ok = matchOn.every((k) => product[k] !== undefined && product[k] !== null && String(product[k]) === String((row.match || {})[k]));
    return { index, match: row.match || {}, rate: String(row.rate), ok };
  });
  const hit = checked.find((c) => c.ok);

  const steps = [];
  let running;
  let source;
  let formula = null;
  let usedInputs = null;

  if (hit) {
    source = 'CATALOG';
    running = new Decimal(book.rows[hit.index].rate);
    steps.push(trace.step('CATALOG_RATE', 'RULE', { delta: running, runningTotal: running, note: { row: describeMatch(hit.match), source: 'CATALOG' } }));
  } else {
    source = 'FORMULA';
    if (!book.fallbackFormula) {
      return missingLine(item, book, 'NO_CATALOG_ROW', `No catalog row for ${matchOn.map((k) => `${k}=${product[k]}`).join(', ')} and the book has no fallback formula.`, { checked });
    }
    const inputs = costInputsInForce(book.costInputs, ctx.priceDate);
    const vars = { ...product, quantity, cost: inputs.values };
    let ast;
    try {
      ast = parse(book.fallbackFormula);
    } catch (err) {
      return missingLine(item, book, 'FORMULA_INVALID', err.message, { checked });
    }
    let evaluated;
    try {
      evaluated = evaluate(ast, vars);
    } catch (err) {
      if (err instanceof FormulaInputError) {
        const isCostInput = err.variable.startsWith('cost.');
        return missingLine(item, book, isCostInput ? 'COST_INPUT_NOT_IN_FORCE' : 'FORMULA_INPUT_MISSING',
          isCostInput
            ? `Cost input "${err.variable}" has no value in force on ${ctx.priceDate}.`
            : `The line has no value for "${err.variable}", which the formula needs.`,
          { checked, formula: book.fallbackFormula, variable: err.variable });
      }
      if (err instanceof FormulaEvalError || err instanceof FormulaSyntaxError) {
        return missingLine(item, book, 'FORMULA_INVALID', err.message, { checked, formula: book.fallbackFormula });
      }
      throw err;
    }
    // Purpose gate (requirements §7): a BINDING quote may not rest on an estimated cost input.
    const usedProvenance = Object.fromEntries(Object.keys(evaluated.used).filter((k) => k.startsWith('cost.')).map((k) => [k, inputs.provenance[k.slice(5)]]));
    const weakest = Object.values(usedProvenance).find((p) => p && p.confidence !== CONFIDENCE.EXACT);
    if (weakest && !purposeAllows(weakest.confidence, ctx.purpose || PURPOSE.INDICATIVE, item.overrideStaleCost)) {
      return {
        partNumber: item.partNumber,
        status: 'BLOCKED',
        missing: { reason: 'CONFIDENCE_BLOCKED_BY_PURPOSE', confidence: weakest.confidence, purpose: ctx.purpose },
        trace: { technique: 'CATALOG_FORMULA', book: book.id, bookVersion: book.version, checked, formula: book.fallbackFormula, costInputs: usedProvenance, steps: [] },
      };
    }
    formula = { source: book.fallbackFormula, dslVersion: book.dsl_version || 1, used: evaluated.used, value: evaluated.value.toString() };
    usedInputs = usedProvenance;
    running = evaluated.value;
    steps.push(trace.step('FORMULA_COST', 'FORMULA', { delta: running, runningTotal: running, note: { formula: book.fallbackFormula, used: evaluated.used, source: 'FORMULA' } }));
  }

  const freight = new Decimal(book.freight || 0);
  if (freight.isZero()) steps.push(trace.step('FREIGHT', 'ADDER', { delta: new Decimal(0), runningTotal: running, note: { skipped: true, reason: 'NO_FREIGHT' } }));
  else { running = running.plus(freight); steps.push(trace.step('FREIGHT', 'ADDER', { delta: freight, runningTotal: running, note: { source: 'CONFIG' } })); }
  const landedCost = running;

  let marginRate = null;
  if (source === 'FORMULA') {
    const margin = resolveRows(book.margin || [], attrs, dimensions, ctx.priceDate);
    if (margin.ambiguous) return missingLine(item, book, 'AMBIGUOUS_RULE', 'Two margin rows match with equal specificity.', { checked });
    marginRate = margin.winner ? new Decimal(margin.winner.row.value) : new Decimal(0);
    const delta = landedCost.times(marginRate);
    running = running.plus(delta);
    steps.push(trace.step('MARGIN', 'PERCENT', { delta, runningTotal: running, note: { rate: marginRate.toString(), basis: ['FORMULA_COST', 'FREIGHT'], row: margin.winner ? describeMatch(margin.winner.row.match) : 'none' } }));
  } else {
    steps.push(trace.step('MARGIN', 'PERCENT', { delta: new Decimal(0), runningTotal: running, note: { skipped: true, reason: 'CATALOG_RATE_IS_SELL_PRICE' } }));
  }

  const discount = resolveRows(book.discount || [], attrs, dimensions, ctx.priceDate);
  if (discount.ambiguous) return missingLine(item, book, 'AMBIGUOUS_RULE', 'Two discount rows match with equal specificity.', { checked });
  const discountRate = discount.winner ? new Decimal(discount.winner.row.value) : new Decimal(0);
  if (discountRate.isZero()) steps.push(trace.step('CUST_DISC', 'PERCENT', { delta: new Decimal(0), runningTotal: running, note: { skipped: true, reason: discount.winner ? 'RATE_ZERO' : 'NO_MATCHING_ROW' } }));
  else { const delta = running.times(discountRate).neg(); running = running.plus(delta); steps.push(trace.step('CUST_DISC', 'PERCENT', { delta, runningTotal: running, note: { rate: discountRate.toString(), row: describeMatch(discount.winner.row.match) } })); }

  running = roundTo(running, rounding);

  let realisedMargin = null;
  let floor = null;
  if (source === 'FORMULA') {
    realisedMargin = landedCost.isZero() ? new Decimal(0) : running.minus(landedCost).div(landedCost);
    if (book.floor !== undefined && book.floor !== null) {
      const floorRate = new Decimal(book.floor);
      floor = { rate: floorRate.toString(), realised: realisedMargin.toString(), breached: realisedMargin.lt(floorRate) };
    }
  }

  return {
    partNumber: item.partNumber,
    status: 'PRICED',
    result: {
      unitPrice: running.toString(),
      landedCost: source === 'FORMULA' ? landedCost.toString() : null,
      margin: realisedMargin ? realisedMargin.toString() : null,
      currency: book.currency,
      quantity,
    },
    trace: {
      technique: 'CATALOG_FORMULA',
      book: book.id,
      bookVersion: book.version,
      source,
      checked,
      formula,
      costInputs: usedInputs,
      marginRate: marginRate ? marginRate.toString() : null,
      floor,
      attributes: attrs,
      steps,
      constraintPasses: [],
    },
  };
}

module.exports = { priceCatalogItem, costInputsInForce, DEFAULT_DIMENSIONS, DEFAULT_MATCH_ON };
