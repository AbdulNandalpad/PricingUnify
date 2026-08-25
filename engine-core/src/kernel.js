/** Kernel: applies a region config (build-up of typed elements) to resolved facts.
 *  Signature: price({ request, facts, config }) -> { items: [{ partNumber, status, result?, missing?, trace }] }
 *  Pure: no I/O, no wall-clock, no randomness. Same input -> same output (requirements §5.3). */
const Decimal = require('decimal.js');
const { resolveCandidate, purposeAllows, PURPOSE } = require('./cost');
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
 *  Supports "path.to.field OP literal" only; anything richer is a Phase-2+ config-model concern. */
function evaluateWhen(expr, scope) {
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
  const purpose = (request.context && request.context.purpose) || PURPOSE.INDICATIVE;
  const costFacts = facts.costs && facts.costs[item.partNumber];
  const { chosen, reason, matchedStep } = resolveCandidate(costFacts, item.selectedCostId, config.costAccessSequence);

  if (!chosen) {
    return {
      partNumber: item.partNumber,
      status: 'MISSING',
      missing: { reason: reason || 'COST_MISSING' },
      trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: null, steps: [] }),
    };
  }

  // Which of the three ways this candidate was picked — never silent about it (requirements §5.2).
  const selectedBy = item.selectedCostId ? 'USER' : matchedStep ? `ACCESS_SEQUENCE:${matchedStep}` : 'DEFAULT';
  if (!purposeAllows(chosen.confidence, purpose, item.overrideStaleCost)) {
    return {
      partNumber: item.partNumber,
      status: 'BLOCKED',
      missing: { reason: 'CONFIDENCE_BLOCKED_BY_PURPOSE', confidence: chosen.confidence, purpose },
      trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: chosen, selectedBy, steps: [] }),
    };
  }

  const itemFacts = { elements: (facts.elements && facts.elements[item.partNumber]) || {}, fx: facts.fx };
  const scope = { item, facts: itemFacts };
  const ctx = { baseCost: new Decimal(chosen.value), quantity: item.quantity, facts: itemFacts, stepValues: {} };

  let running = new Decimal(0);
  const steps = [];

  for (const el of config.buildUp) {
    if (el.when && !evaluateWhen(el.when, scope)) continue;

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
        trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: chosen, selectedBy, steps }),
      };
    }

    ctx.stepValues[el.id] = result.delta;
    running = running.plus(result.delta);
    steps.push(trace.step(el.id, el.type, { delta: result.delta, runningTotal: running, note: result.note }));
  }

  const constraintPasses = [];
  for (const c of config.constraints || []) {
    const res = applyConstraint(c, running, { facts: itemFacts, quantity: item.quantity });
    if (res.applied) {
      constraintPasses.push({ id: c.id, from: running.toString(), to: res.total.toString(), ...res.note });
      running = res.total;
    }
  }

  running = roundTotal(running, config.rounding);

  return {
    partNumber: item.partNumber,
    status: 'PRICED',
    result: { unitPrice: running.toString(), currency: chosen.currency, quantity: item.quantity },
    trace: trace.build({ region: config.region, configVersion: config.version, costCandidate: chosen, selectedBy, steps, constraintPasses }),
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
