/** Formula DSL v1 (ARCHITECTURE_V2 §2.4): own tokenizer + Pratt parser to a closed AST,
 *  evaluated in decimal.js. Deliberately tiny — numbers, dotted identifiers, + - * / ^,
 *  parentheses, unary minus, min/max/round/abs. No eval, no Function, no other syntax.
 *  Config is data; this keeps it that way even when the data is a formula. */
const Decimal = require('decimal.js');

const DSL_VERSION = 1;
const FUNCTIONS = {
  min: (args) => args.reduce((a, b) => (b.lt(a) ? b : a)),
  max: (args) => args.reduce((a, b) => (b.gt(a) ? b : a)),
  round: (args) => args[0].toDecimalPlaces(args[1] ? args[1].toNumber() : 0, Decimal.ROUND_HALF_UP),
  abs: (args) => args[0].abs(),
};
const ARITY = { min: [1, Infinity], max: [1, Infinity], round: [1, 2], abs: [1, 1] };

class FormulaSyntaxError extends Error {
  constructor(message, position) {
    super(`${message} (at position ${position})`);
    this.name = 'FormulaSyntaxError';
    this.position = position;
  }
}
class FormulaInputError extends Error {
  constructor(variable) {
    super(`Formula input "${variable}" has no value.`);
    this.name = 'FormulaInputError';
    this.variable = variable;
  }
}
class FormulaEvalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormulaEvalError';
  }
}

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)|([-+*/^(),]))/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(pos))) break;
      throw new FormulaSyntaxError(`Unexpected character "${src[pos]}"`, pos);
    }
    if (m[1] !== undefined) tokens.push({ type: 'num', value: m[1], pos });
    else if (m[2] !== undefined) tokens.push({ type: 'id', value: m[2], pos });
    else tokens.push({ type: 'op', value: m[3], pos });
    pos = re.lastIndex;
  }
  tokens.push({ type: 'eof', pos: src.length });
  return tokens;
}

const BINARY_PRECEDENCE = { '+': 10, '-': 10, '*': 20, '/': 20, '^': 30 };
const RIGHT_ASSOC = { '^': true };

function parse(src) {
  if (typeof src !== 'string' || !src.trim()) throw new FormulaSyntaxError('Empty formula', 0);
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expectOp = (value) => {
    const t = next();
    if (t.type !== 'op' || t.value !== value) throw new FormulaSyntaxError(`Expected "${value}"`, t.pos);
  };

  function parsePrimary() {
    const t = next();
    if (t.type === 'num') return { type: 'num', value: t.value };
    if (t.type === 'id') {
      if (peek().type === 'op' && peek().value === '(') {
        if (!FUNCTIONS[t.value]) throw new FormulaSyntaxError(`Unknown function "${t.value}"`, t.pos);
        next();
        const args = [];
        if (!(peek().type === 'op' && peek().value === ')')) {
          args.push(parseExpression(0));
          while (peek().type === 'op' && peek().value === ',') { next(); args.push(parseExpression(0)); }
        }
        expectOp(')');
        const [min, max] = ARITY[t.value];
        if (args.length < min || args.length > max) throw new FormulaSyntaxError(`"${t.value}" takes ${min === max ? min : `${min}-${max === Infinity ? 'n' : max}`} argument(s)`, t.pos);
        return { type: 'call', name: t.value, args };
      }
      return { type: 'var', name: t.value };
    }
    if (t.type === 'op' && t.value === '(') {
      const e = parseExpression(0);
      expectOp(')');
      return e;
    }
    if (t.type === 'op' && t.value === '-') return { type: 'neg', expr: parseExpression(25) };
    throw new FormulaSyntaxError(t.type === 'eof' ? 'Unexpected end of formula' : `Unexpected "${t.value}"`, t.pos);
  }

  function parseExpression(minPrec) {
    let left = parsePrimary();
    for (;;) {
      const t = peek();
      if (t.type !== 'op' || !(t.value in BINARY_PRECEDENCE)) break;
      const prec = BINARY_PRECEDENCE[t.value];
      if (prec < minPrec) break;
      next();
      const right = parseExpression(RIGHT_ASSOC[t.value] ? prec : prec + 1);
      left = { type: 'bin', op: t.value, left, right };
    }
    return left;
  }

  const ast = parseExpression(0);
  if (peek().type !== 'eof') throw new FormulaSyntaxError(`Unexpected "${peek().value}"`, peek().pos);
  return ast;
}

// Own properties only: a formula must never reach prototype members like `toString`.
function readPath(vars, name) {
  return name.split('.').reduce((o, k) => (o != null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), vars);
}

/** Evaluates a parsed AST. `vars` is a plain object (dotted names walk nested objects).
 *  Returns { value: Decimal, used: { name: 'value' } } — `used` is what the trace shows. */
function evaluate(ast, vars) {
  const used = {};
  function ev(node) {
    switch (node.type) {
      case 'num': return new Decimal(node.value);
      case 'var': {
        const raw = readPath(vars, node.name);
        if (raw === undefined || raw === null || raw === '') throw new FormulaInputError(node.name);
        const d = new Decimal(raw);
        used[node.name] = d.toString();
        return d;
      }
      case 'neg': return ev(node.expr).neg();
      case 'call': return FUNCTIONS[node.name](node.args.map(ev));
      case 'bin': {
        const l = ev(node.left), r = ev(node.right);
        switch (node.op) {
          case '+': return l.plus(r);
          case '-': return l.minus(r);
          case '*': return l.times(r);
          case '/': if (r.isZero()) throw new FormulaEvalError('Division by zero'); return l.div(r);
          case '^': return l.pow(r);
        }
      }
    }
    throw new FormulaEvalError(`Unknown node ${node.type}`);
  }
  return { value: ev(ast), used };
}

function collectVariables(ast, out = new Set()) {
  if (ast.type === 'var') out.add(ast.name);
  else if (ast.type === 'neg') collectVariables(ast.expr, out);
  else if (ast.type === 'bin') { collectVariables(ast.left, out); collectVariables(ast.right, out); }
  else if (ast.type === 'call') ast.args.forEach((a) => collectVariables(a, out));
  return out;
}

/** Config-time check: parses, and reports variables the formula uses that `available` does
 *  not provide. Returns { ok, variables, unknown, error }. Never throws. */
function validateFormula(src, available = []) {
  try {
    const ast = parse(src);
    const variables = [...collectVariables(ast)];
    const unknown = available.length ? variables.filter((v) => !available.includes(v)) : [];
    return { ok: unknown.length === 0, variables, unknown, error: null };
  } catch (err) {
    return { ok: false, variables: [], unknown: [], error: err.message };
  }
}

function evaluateFormula(src, vars) {
  return evaluate(parse(src), vars);
}

module.exports = { DSL_VERSION, parse, evaluate, evaluateFormula, validateFormula, collectVariables, FormulaSyntaxError, FormulaInputError, FormulaEvalError };
