/** Kernel: applies a region config (build-up of typed elements) to resolved facts.
 *  Signature: price({ request, facts, config }) -> { items: [{ partNumber, status, result?, missing?, trace }] }
 *  Pure: no I/O, no wall-clock, no randomness. Same input -> same output (requirements §5.3). */
const Decimal = require('decimal.js');
const { resolveCandidate, resolveAccessSequence, purposeAllows, PURPOSE } = require('./cost');
const { applyBase, applyFactor, applyAdder, applyPerLine, applyConstraint, readPath } = require('./elements');
const { roundTo } = require('./rounding');
const trace = require('./trace');

function parseLiteral(raw) {
  if (/^'.*'$/.test(raw) || /^".*"$/.test(raw)) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const n = Number(raw);
  return Number.isNaN(n) ? raw : n;
}

/** Deliberately not `eval`/`Function` — config is data, and this keeps it that way.
 *  Supports "path.to.field OP literal" only; anything richer is a Phase-2+ config-model concern.
 *  An array of expressions is AND-ed together (all must be true) — real regional logic often
 *  branches on more than one field at once (e.g. China: origin of data AND supplier AND COO). */
function evaluateWhen(expr, scope) {
  if (Array.isArray(expr)) return expr.every((e) => evaluateWhen(e, scope));
  const m = String(expr).match(/^\s*([\w.]+)\s*(===|==|!==|!=|>=|<=|>|<)\s*(.+?)\s*$/);
  if (!m) throw new Error(`Unsupported "when" expression: "${expr}"`);
  const [, path, op, rawValue] = m;
  const left = readPath(scope, path);
  const right = parseLiteral(rawValue);
  switch (op) {
    case '===': case '==': return left === right;
    case '!==': case '!=': return left !== right;
    case '>': return left > right;
    case '<': return left < right;
    case '>=': return left >= right;
    case '<=': return left <= right;
    default: return false;
  }
}

/** Sell price on top of the landed cost (ARCHITECTURE_V2 §2.2, owner decision 2026-09-10):
 *  unitPrice = landedCost / (1 - margin). The margin is the line's own override when the
 *  rep set one, else the region's `sell.defaultMargin`. A region with no `sell` section
 *  keeps unitPrice = landedCost (margin null) — every pre-v2 config prices unchanged. */
function resolveSell(item, config, landedCost) {
  const raw = item.marginOverride !== undefined && item.marginOverride !== null && item.marginOverride !== ''
    ? item.marginOverride
    : config.sell && config.sell.defaultMargin !== undefined && config.sell.defaultMargin !== null
      ? config.sell.defaultMargin
      : null;
  if (raw === null) return { unitPrice: landedCost, margin: null, source: null };
  const margin = new Decimal(raw);
  if (margin.lt(0) || margin.gte(1)) return { error: { reason: 'MARGIN_INVALID', detail: `Margin ${margin.toString()} must be between 0 and 1 (exclusive).` } };
  const unitPrice = roundTo(landedCost.div(new Decimal(1).minus(margin)), (config.sell && config.sell.rounding) || config.rounding);
  return { unitPrice, margin, source: item.marginOverride !== undefined && item.marginOverride !== null && item.marginOverride !== '' ? 'LINE_OVERRIDE' : 'REGION_DEFAULT' };
}

function priceItem(item, request, facts, config) {
  // The caller (srv) resolves each region's raw ERP stock-class code (OMT, SMT, MTS-Z, ...)
  // into item.stockClass ('MTS'|'NonMTS') before engine-core ever sees the item — the kernel
  // stays ERP-agnostic and only ever branches on the clean value via `when`. If the caller
  // couldn't resolve it (region needs stock class but the code was missing or unrecognized),
  // it sets item.stockClassError instead — silently skipping the stockClass-conditioned
  // elements would risk under-pricing, so this is a typed MISSING, not a guess.
  if (item.stockClassError) {
    return {
      partNumber: item.partNumber,
      status: 'MISSING',
      missing: { reason: 'STOCK_CLASS_UNRESOLVED', detail: item.stockClassError },
      trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: null, steps: [] }),
    };
  }

  // Same pattern as stockClassError: the caller resolves item.additionalCost (a line-level
  // "which adders apply" flag) into item.include*/additionalCostError before engine-core ever
  // sees the item, via this region's additionalCostMap. An unrecognized flag value is a typed
  // MISSING, not a guess at which elements should apply.
  if (item.additionalCostError) {
    return {
      partNumber: item.partNumber,
      status: 'MISSING',
      missing: { reason: 'ADDITIONAL_COST_UNRESOLVED', detail: item.additionalCostError },
      trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: null, steps: [] }),
    };
  }

  const purpose = (request.context && request.context.purpose) || PURPOSE.INDICATIVE;
  const costFacts = facts.costs && facts.costs[item.partNumber];
  const accessSequence = resolveAccessSequence(config.costAccessSequence, item.stockClass);
  const { chosen, reason, matchedStep } = resolveCandidate(costFacts, item.selectedCostId, accessSequence);

  if (!chosen) {
    return {
      partNumber: item.partNumber,
      status: 'MISSING',
      missing: { reason: reason || 'COST_MISSING' },
      trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: null, steps: [], stockClass: item.stockClass }),
    };
  }

  // Which of the three ways this candidate was picked — never silent about it (requirements §5.2).
  const selectedBy = item.selectedCostId ? 'USER' : matchedStep ? `ACCESS_SEQUENCE:${matchedStep}` : 'DEFAULT';
  if (!purposeAllows(chosen.confidence, purpose, item.overrideStaleCost)) {
    return {
      partNumber: item.partNumber,
      status: 'BLOCKED',
      missing: { reason: 'CONFIDENCE_BLOCKED_BY_PURPOSE', confidence: chosen.confidence, purpose },
      trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: chosen, selectedBy, steps: [], stockClass: item.stockClass }),
    };
  }

  const itemFacts = { elements: (facts.elements && facts.elements[item.partNumber]) || {}, fx: facts.fx };
  const scope = { item, facts: itemFacts };
  const ctx = { baseCost: new Decimal(chosen.value), quantity: item.quantity, facts: itemFacts, stepValues: {} };

  let running = new Decimal(0);
  const steps = [];

  for (const el of config.buildUp) {
    if (el.when && !evaluateWhen(el.when, scope)) {
      // A skipped element still contributes a (zero) step value so a later FACTOR can safely
      // list it in `basis` alongside the mutually-exclusive branch that DID fire — e.g. China's
      // COO-conditioned freight&duty factors, where exactly one of them ever actually applies.
      // The skip itself is recorded in the trace too — a BINDING caller needs to see why a
      // branch didn't apply, not just what happened in the branch that did.
      ctx.stepValues[el.id] = new Decimal(0);
      steps.push(trace.step(el.id, el.type, { delta: new Decimal(0), runningTotal: running, note: { skipped: true, when: el.when } }));
      continue;
    }

    let result;
    switch (el.type) {
      case 'BASE': result = applyBase(el, ctx); break;
      case 'FACTOR': result = applyFactor(el, ctx); break;
      case 'ADDER': result = applyAdder(el, ctx); break;
      case 'PER_LINE': result = applyPerLine(el, ctx); break;
      default: throw new Error(`Unknown build-up element type "${el.type}" on "${el.id}".`);
    }

    if (result.missing) {
      steps.push(trace.step(el.id, el.type, { missing: result.missing }));
      return {
        partNumber: item.partNumber,
        status: 'MISSING',
        missing: { ...result.missing, elementId: el.id },
        trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: chosen, selectedBy, steps, stockClass: item.stockClass }),
      };
    }

    ctx.stepValues[el.id] = result.delta;
    running = running.plus(result.delta);
    steps.push(trace.step(el.id, el.type, { delta: result.delta, runningTotal: running, note: result.note }));
  }

  const constraintPasses = [];
  let quantity = item.quantity;
  for (const c of config.constraints || []) {
    const res = applyConstraint(c, running, { facts: itemFacts, quantity });
    if (res.applied) {
      constraintPasses.push({ id: c.id, from: running.toString(), to: res.total.toString(), ...res.note });
      running = res.total;
      // A FLOOR constraint in QUANTITY mode adjusts the order quantity instead of the unit
      // price (config-driven — see elements.js). Later constraints in this same pass (e.g. a
      // MOQ check) see the adjusted quantity, same as they'd see an adjusted price.
      if (res.quantity) quantity = res.quantity.toNumber();
    }
  }

  running = roundTo(running, config.rounding);

  const sell = resolveSell(item, config, running);
  if (sell.error) {
    return {
      partNumber: item.partNumber,
      status: 'MISSING',
      missing: sell.error,
      trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: chosen, selectedBy, steps, constraintPasses, stockClass: item.stockClass }),
    };
  }

  return {
    partNumber: item.partNumber,
    status: 'PRICED',
    result: {
      unitPrice: sell.unitPrice.toString(),
      landedCost: running.toString(),
      margin: sell.margin ? sell.margin.toString() : null,
      currency: chosen.currency,
      quantity,
    },
    trace: trace.build({
      region: config.region,
      configVersion: config.version,
      costCandidate: chosen,
      selectedBy,
      steps,
      constraintPasses,
      stockClass: item.stockClass,
      sell: sell.margin ? { margin: sell.margin.toString(), source: sell.source, landedCost: running.toString() } : null,
    }),
  };
}

function price(input) {
  const { request, facts, config } = input || {};
  if (!request || !facts || !config) {
    throw new Error('price() requires { request, facts, config }. See docs/PRICING_ENGINE_REQUIREMENTS.md §7.');
  }
  if (!Array.isArray(config.buildUp)) {
    throw new Error(`Config for region "${config.region}" has no buildUp sequence.`);
  }
  return { items: request.items.map(item => priceItem(item, request, facts, config)) };
}

module.exports = { price };
