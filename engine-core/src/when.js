/**
 * The `when` expression grammar, in one place: the kernel EVALUATES with it and config-model
 * VALIDATES with it, so a condition that passes validation at save time is a condition the
 * kernel can run — a saved config can never brick a region by containing an expression the
 * kernel then refuses. Pure: no I/O, no eval.
 */
const { readPath } = require('./elements');

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

const IN_RE = /^\s*([\w.]+)\s+in\s+(.+?)\s*$/;
const CMP_RE = /^\s*([\w.]+)\s*(===|==|!==|!=|>=|<=|>|<)\s*(.+?)\s*$/;

/**
 * Syntax check only (never evaluates). Returns an error message, or null when `expr` — a string,
 * or a non-empty array of strings that are AND-ed — is something evaluateWhen can run.
 */
function checkWhen(expr) {
  if (Array.isArray(expr)) {
    if (expr.length === 0) return 'an empty "when" list';
    for (const e of expr) { const bad = checkWhen(e); if (bad) return bad; }
    return null;
  }
  if (typeof expr !== 'string' || expr.trim() === '') return `"when" must be a non-empty expression, got ${JSON.stringify(expr)}`;
  if (IN_RE.test(expr)) {
    const list = expr.match(IN_RE)[2].split(',').map((v) => v.trim());
    return list.some((v) => v === '') ? `empty value in the list of "${expr}"` : null;
  }
  const m = expr.match(CMP_RE);
  if (!m) return `unsupported "when" expression "${expr}" (use: path OP value, or path in A,B,C — OP is one of === !== == != > < >= <=)`;
  return null;
}

module.exports = { evaluateWhen, checkWhen, parseLiteral };
