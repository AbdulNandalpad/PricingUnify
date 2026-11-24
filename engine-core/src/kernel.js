/** Kernel: applies a region config (build-up of typed elements) to resolved facts.
 *  Signature: price({ request, facts, config }) -> { items: [{ partNumber, status, result?, missing?, trace }] }
 *  Pure: no I/O, no wall-clock, no randomness. Same input -> same output (requirements §5.3). */
const Decimal = require('decimal.js');
const { resolveCandidate, resolveAccessSequence, purposeAllows, PURPOSE } = require('./cost');
const { applyBase, applyFactor, applyAdder, applyPerLine, applyConstraint, readPath } = require('./elements');
const trace = require('./trace');

const ROUNDING_MODES = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  UP: Decimal.ROUND_UP,
  DOWN: Decimal.ROUND_DOWN,
  CEIL: Decimal.ROUND_CEIL,
  FLOOR: Decimal.ROUND_FLOOR,
};

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
  // "path in A,B,C" — list membership (e.g. India's margin by product-category group).
  const inM = String(expr).match(/^\s*([\w.]+)\s+in\s+(.+?)\s*$/);
  if (inM) {
    const left = readPath(scope, inM[1]);
    return inM[2].split(',').map((v) => parseLiteral(v.trim())).some((v) => v === left);
  }
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

function roundTotal(total, rounding) {
  if (!rounding || rounding.decimalPlaces === undefined) return total;
  const mode = ROUNDING_MODES[rounding.mode] ?? Decimal.ROUND_HALF_UP;
  return total.toDecimalPlaces(rounding.decimalPlaces, mode);
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

  // Supported pricing types are COST_PLUS and PRICE_LIST only (owner decision 2026-11-24).
  // The caller (srv) validates item.pricingType and sets pricingTypeError for anything else —
  // same resolved-before-the-kernel pattern as stockClassError/additionalCostError, so the
  // kernel itself stays free of pricing-type branching (PRICE_LIST only changes WHICH cost
  // candidate arrives, selected upstream; the build-up is identical either way).
  if (item.pricingTypeError) {
    return {
      partNumber: item.partNumber,
      status: 'MISSING',
      missing: { reason: 'PRICING_TYPE_UNSUPPORTED', detail: item.pricingTypeError },
      trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: null, steps: [] }),
    };
  }

  // A PRICE_LIST line whose price-list lookup (by supplier, then product category) found no
  // cost is a typed MISSING naming what was tried — never a silent fall-back to COST_PLUS,
  // since the user explicitly asked for the price list.
  if (item.priceListError) {
    return {
      partNumber: item.partNumber,
      status: 'MISSING',
      missing: { reason: 'PRICE_LIST_COST_NOT_FOUND', detail: item.priceListError },
      trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: null, steps: [], stockClass: item.stockClass }),
    };
  }

  if (item.priceUnit !== undefined && item.priceUnit !== null) {
    let valid = false;
    try { const u = new Decimal(item.priceUnit); valid = u.isFinite() && u.gt(0); } catch (e) { valid = false; }
    if (!valid) {
      return {
        partNumber: item.partNumber,
        status: 'MISSING',
        missing: { reason: 'PRICE_UNIT_INVALID', detail: String(item.priceUnit) },
        trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: null, steps: [], stockClass: item.stockClass }),
      };
    }
  }

  // Selling price: either a MARGIN (% of the selling price, gross margin) or a MANUAL price the
  // user typed — validated up front, never guessed. Both are optional; without either the line
  // is a pure cost (landed cost) result, exactly as before.
  const hasManualPrice = item.manualPrice !== undefined && item.manualPrice !== null && item.manualPrice !== '';
  let hasMargin = item.margin && item.margin.marginPct !== undefined && item.margin.marginPct !== null && item.margin.marginPct !== '';
  // Predefined margin (config: region-config.marginRules, first matching rule wins) — only when
  // the caller gave neither a margin nor a price: an explicit user/host margin always wins.
  let marginRule = null;
  if (!hasManualPrice && !hasMargin && Array.isArray(config.marginRules)) {
    for (const rule of config.marginRules) {
      let hit = false;
      try { hit = !rule.when || evaluateWhen(rule.when, { item }); } catch (e) { hit = false; }
      if (hit) { marginRule = rule; break; }
    }
    if (marginRule) { item = { ...item, margin: { marginPct: marginRule.marginPct } }; hasMargin = true; }
  }
  if (hasManualPrice || hasMargin) {
    let bad = null;
    try {
      if (hasManualPrice) { const p = new Decimal(item.manualPrice); if (!(p.isFinite() && p.gt(0))) bad = { reason: 'MANUAL_PRICE_INVALID', detail: String(item.manualPrice) }; }
      else { const m = new Decimal(item.margin.marginPct); if (!(m.isFinite() && m.gte(0) && m.lt(100))) bad = { reason: 'MARGIN_INVALID', detail: `${item.margin.marginPct} (must be >= 0 and < 100)` }; }
    } catch (e) { bad = { reason: hasManualPrice ? 'MANUAL_PRICE_INVALID' : 'MARGIN_INVALID', detail: String(hasManualPrice ? item.manualPrice : item.margin.marginPct) }; }
    if (bad) {
      return { partNumber: item.partNumber, status: 'MISSING', missing: bad,
        trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: null, steps: [], stockClass: item.stockClass }) };
    }
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

  // Price/cost unit (C4C's c4cMultiplyAmnt, 100 = "per 100 pieces"): everything above is
  // computed per piece at full decimal precision; the unit is applied only HERE, just before the
  // declared rounding, so cents-level parts keep their precision (0.0364 per piece -> 3.64 per
  // 100 instead of rounding to 0.04 per piece first). Unset = 1 = unchanged behaviour.
  const priceUnit = new Decimal(item.priceUnit === undefined || item.priceUnit === null ? 1 : item.priceUnit);
  running = roundTotal(running.times(priceUnit), config.rounding);

  // Selling price on top of the landed cost (same per-price-unit basis as `unitPrice`):
  //   MARGIN: price = landed / (1 - margin%)   (margin is a share of the SELLING price)
  //   MANUAL: price as typed; the margin it implies = (price - landed) / price
  let selling = null;
  if (hasManualPrice) {
    const p = new Decimal(item.manualPrice);
    selling = { sellingPrice: p, marginPct: p.minus(running).div(p).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP), priceBy: 'MANUAL' };
  } else if (hasMargin) {
    const m = new Decimal(item.margin.marginPct);
    selling = { sellingPrice: roundTotal(running.div(new Decimal(1).minus(m.div(100))), config.rounding), marginPct: m, priceBy: marginRule ? 'DEFAULT_RULE' : 'MARGIN', ...(marginRule ? { marginRule: marginRule.id || null } : {}) };
  }

  return {
    partNumber: item.partNumber,
    status: 'PRICED',
    result: { unitPrice: running.toString(), currency: chosen.currency, quantity, ...(priceUnit.eq(1) ? {} : { priceUnit: priceUnit.toString() }),
      ...(selling ? { sellingPrice: selling.sellingPrice.toString(), marginPct: selling.marginPct.toString(), priceBy: selling.priceBy, ...(selling.marginRule !== undefined ? { marginRule: selling.marginRule } : {}) } : {}) },
    trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: chosen, selectedBy, steps, constraintPasses, stockClass: item.stockClass }),
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
