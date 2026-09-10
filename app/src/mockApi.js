/** DEV AID ONLY — an in-browser stand-in for srv, enabled with `VITE_API_MODE=mock`.
 *  Answers every §4.3 endpoint in the exact contract shapes (numbers as decimal strings,
 *  the unified line result, DRAFT → publish lifecycle, suggestions) from `mockData.js`.
 *  Its arithmetic is plain JS and exists only so the screens can be clicked through before
 *  the rebuilt backend is up. The real app never prices in the browser: `api.js` only routes
 *  here when the mock flag is set. */
import { ApiError } from './api.js';
import { PARTS, USERS, seedDocuments } from './mockData.js';

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const r2 = (n) => Math.round(n * 100) / 100;
const s2 = (n) => String(r2(n));
const today = () => new Date().toISOString().slice(0, 10);

const state = { docs: seedDocuments(), suggestions: [], pricingDocs: [], seq: 0 };

function fail(status, message, code) {
  throw new ApiError(status, { error: { code: code || String(status), message } });
}

/* ── document store ─────────────────────────────────────────────────────── */
const LIVE = new Set(['ACTIVE', 'SUPERSEDED']);
const bucket = (kind, key) => state.docs.filter((d) => d.kind === kind && d.key === key);
function effective(kind, key, asOf) {
  const date = asOf || today();
  const pick = (k) => bucket(kind, k).find((d) => LIVE.has(d.status) && d.validFrom <= date && (!d.validTo || date < d.validTo));
  let hit = pick(key);
  if (!hit && String(key).includes('::')) hit = pick(`${String(key).slice(0, String(key).lastIndexOf('::'))}::*`);
  return hit ? hit.doc : null;
}
function nextVersion(kind, key) {
  const day = today();
  const n = bucket(kind, key).filter((d) => String(d.version).startsWith(day)).length + 1;
  return `${day}-r${n}`;
}
function keyOf(kind, doc) {
  if (kind === 'region-config') return `${doc.region}::${doc.salesOrg || '*'}`;
  if (kind === 'region-route') return `${doc.ood}::${doc.salesOrg || '*'}`;
  if (kind === 'routing-rules') return '*';
  return doc.id ?? doc.supplier ?? doc.customerId;
}
const ENVELOPE = new Set(['version', 'status', 'validFrom', 'validTo', 'supersedes', 'provenance']);
function stripEnvelope(doc) {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !ENVELOPE.has(k)));
}

/* ── flat diff, same shape as config-model/src/diff.js ──────────────────── */
function diffDocs(a, b, ignore = ['/version', '/status', '/validFrom', '/validTo', '/supersedes', '/provenance']) {
  const out = [];
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const walk = (x, y, path) => {
    if (isObj(x) && isObj(y)) { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${path}/${k}`); return; }
    if (Array.isArray(x) && Array.isArray(y)) { for (let i = 0; i < Math.max(x.length, y.length); i++) walk(x[i], y[i], `${path}/${i}`); return; }
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path: path || '/', from: x, to: y });
  };
  walk(a, b, '');
  return out.filter((d) => !ignore.some((p) => d.path === p || d.path.startsWith(`${p}/`)));
}

/* ── formula DSL (closed grammar, mirrors engine-core/src/formula.js) ───── */
function parseFormula(src) {
  const toks = String(src).match(/\d+(\.\d+)?|[A-Za-z_][\w.]*|[-+*/^(),]/g) || [];
  if (!toks.length) throw Object.assign(new Error('Formula is empty.'), { code: 'FORMULA_INVALID' });
  const joined = toks.join('');
  if (joined.replace(/\s/g, '') !== String(src).replace(/\s/g, '')) throw Object.assign(new Error('Unexpected character in formula.'), { code: 'FORMULA_INVALID' });
  let i = 0;
  const vars = new Set();
  const peek = () => toks[i];
  const next = () => toks[i++];
  const FN = new Set(['min', 'max', 'round', 'abs']);
  function prim() {
    const t = next();
    if (t === undefined) throw Object.assign(new Error('Unexpected end of formula.'), { code: 'FORMULA_INVALID' });
    if (t === '(') { const v = expr(); if (next() !== ')') throw Object.assign(new Error('Expected ")".'), { code: 'FORMULA_INVALID' }); return v; }
    if (t === '-') return { neg: prim() };
    if (/^\d/.test(t)) return { num: Number(t) };
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') {
        if (!FN.has(t)) throw Object.assign(new Error(`Unknown function "${t}" — only min, max, round, abs are allowed.`), { code: 'FORMULA_INVALID' });
        next(); const args = [expr()]; while (peek() === ',') { next(); args.push(expr()); }
        if (next() !== ')') throw Object.assign(new Error('Expected ")" after arguments.'), { code: 'FORMULA_INVALID' });
        return { fn: t, args };
      }
      vars.add(t); return { id: t };
    }
    throw Object.assign(new Error(`Unexpected "${t}" at token ${i}.`), { code: 'FORMULA_INVALID' });
  }
  function pow() { let v = prim(); while (peek() === '^') { next(); v = { op: '^', l: v, r: prim() }; } return v; }
  function mul() { let v = pow(); while (peek() === '*' || peek() === '/') { const o = next(); v = { op: o, l: v, r: pow() }; } return v; }
  function expr() { let v = mul(); while (peek() === '+' || peek() === '-') { const o = next(); v = { op: o, l: v, r: mul() }; } return v; }
  const ast = expr();
  if (i < toks.length) throw Object.assign(new Error(`Unexpected "${toks[i]}" after the end of the expression.`), { code: 'FORMULA_INVALID' });
  return { ast, variables: [...vars] };
}
function evalAst(n, scope, used) {
  if ('num' in n) return n.num;
  if ('neg' in n) return -evalAst(n.neg, scope, used);
  if ('id' in n) {
    const v = n.id.split('.').reduce((a, k) => (a == null ? undefined : a[k]), scope);
    if (v === undefined || v === null) throw Object.assign(new Error(`"${n.id}" has no value for this line.`), { variable: n.id });
    used[n.id] = String(v); return Number(v);
  }
  if ('fn' in n) { const a = n.args.map((x) => evalAst(x, scope, used)); return { min: Math.min, max: Math.max, round: Math.round, abs: Math.abs }[n.fn](...a); }
  const l = evalAst(n.l, scope, used), r = evalAst(n.r, scope, used);
  return n.op === '+' ? l + r : n.op === '-' ? l - r : n.op === '*' ? l * r : n.op === '/' ? l / r : l ** r;
}

/* ── stand-in engine ────────────────────────────────────────────────────── */
function readPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }
function parseLit(raw) { if (/^'.*'$/.test(raw) || /^".*"$/.test(raw)) return raw.slice(1, -1); if (raw === 'true') return true; if (raw === 'false') return false; if (raw === 'null') return null; const n = Number(raw); return Number.isNaN(n) ? raw : n; }
function evalWhen(expr, scope) {
  if (!expr) return true;
  if (Array.isArray(expr)) return expr.every((e) => evalWhen(e, scope));
  const m = String(expr).match(/^\s*([\w.]+)\s*(===|==|!==|!=|>=|<=|>|<)\s*(.+?)\s*$/);
  if (!m) return false;
  const l = readPath(scope, m[1]), r = parseLit(m[3]);
  switch (m[2]) { case '===': case '==': return l === r; case '!==': case '!=': return l !== r; case '>': return l > r; case '<': return l < r; case '>=': return l >= r; default: return l <= r; }
}
const describeMatch = (m) => { const e = Object.entries(m || {}); return e.length ? e.map(([k, v]) => `${k} = ${v}`).join(', ') : 'everyone (default)'; };
function resolveRows(rows, attrs, dims, date) {
  const cands = (rows || []).map((row) => {
    const inDate = (!row.validFrom || row.validFrom <= date) && (!row.validTo || date <= row.validTo);
    const matched = Object.entries(row.match || {}).every(([k, v]) => String(attrs[k]) === String(v));
    const specificity = Object.keys(row.match || {}).reduce((s, k) => s + (dims.find((d) => d.attr === k)?.weight ?? 10), 0);
    return { row, matched, inDate, specificity, won: false, reason: !inDate ? 'OUTSIDE_VALIDITY' : !matched ? 'CONDITION_NOT_MET' : null };
  });
  const live = cands.filter((c) => c.matched && c.inDate).sort((a, b) => b.specificity - a.specificity);
  const winner = live[0] || null;
  const ambiguous = live.length > 1 && live[1].specificity === winner.specificity;
  for (const c of live) { if (c === winner) c.won = !ambiguous; else c.reason = `LESS_SPECIFIC:${c.specificity}<${winner.specificity}`; if (ambiguous && c.specificity === winner.specificity) c.reason = 'AMBIGUOUS'; }
  return { winner, candidates: cands, ambiguous };
}
const tierValue = (tiers, qty) => [...(tiers || [])].filter((t) => Number(t.from) <= qty).sort((a, b) => b.from - a.from)[0];
const step = (id, type, delta, running, note) => ({ id, type, delta: delta == null ? null : s2(delta), runningTotal: running == null ? null : s2(running), note: note || null, missing: null });
const missingLine = (item, technique, reason, detail, trace = {}) => ({ partNumber: item.partNumber, status: 'MISSING', technique, book: trace.book || null, missing: { reason, detail }, trace: { technique, steps: [], ...trace } });

function priceCostPlus(item, ctx, cfg) {
  const part = PARTS[item.partNumber];
  const it = { ...item, quantity: Number(item.quantity) || 1 };
  const elements = { ...(part.elements || {}) };
  const notes = [];
  const sup = it.supplier && cfg.suppliers[it.supplier];
  if (sup) {
    if (!it.supplierCountry && sup.supplierCountry) it.supplierCountry = sup.supplierCountry;
    if (sup.molv != null) { elements.molv = Number(sup.molv); notes.push(`MOLV ${sup.molv} from supplier ${it.supplier}`); }
    const wh = it.warehouse && sup.warehouses?.[it.warehouse];
    if (wh) { Object.assign(elements, Object.fromEntries(Object.entries(wh).map(([k, v]) => [k, Number(v)]))); notes.push(`freight/duty/tariff from ${it.supplier} → ${it.warehouse}`); }
    else if (it.warehouse) notes.push(`${it.supplier} has no terms for ${it.warehouse} — part data used`);
  }
  if (part.ood && !it.ood) it.ood = part.ood;
  const R = cfg.region;
  if (R.stockClassMap && !it.stockClass) {
    const raw = part.stockClassRaw;
    if (!raw) return missingLine(it, 'COST_PLUS', 'STOCK_CLASS_NOT_PROVIDED', 'The part carries no ERP stock-class code.');
    if (!(raw in R.stockClassMap)) return missingLine(it, 'COST_PLUS', 'STOCK_CLASS_UNMAPPED', `Raw code "${raw}" is not in the ${R.region} stock class map.`);
    it.stockClass = R.stockClassMap[raw];
  }
  if (R.additionalCostMap && it.additionalCost !== undefined && it.additionalCost !== '') {
    const m = R.additionalCostMap[it.additionalCost];
    if (!m) return missingLine(it, 'COST_PLUS', 'ADDITIONAL_COST_UNMAPPED', `Option ${it.additionalCost} is unknown.`);
    it.includeMarkup = m.markup; it.includeLandedCost = m.landedCost; it.includeTariff = m.tariff; it.includePick = m.pick;
  }
  const cands = (part.costs || []).map((c) => ({ ...c }));
  if (part.qtyBreaks && !it.selectedCostId) {
    const q = Number(it.mroqOverride) || it.quantity;
    const tier = [...part.qtyBreaks].filter((b) => b.minQty <= q).sort((a, b) => b.minQty - a.minQty)[0];
    if (tier) { cands.push({ value: String(tier.value), currency: R.currency, basis: 'SUPPLIER_CATALOG', source: { system: 'JDE_E1', table: 'F41291', field: 'QTY_BREAK', key: `QTY_BREAK_${tier.minQty}` }, confidence: 'EXACT', validFrom: '2026-08-01' }); it.selectedCostId = `QTY_BREAK_${tier.minQty}`; notes.push(`quantity break ≥${tier.minQty} → ${tier.value}`); }
  }
  const seqCfg = R.costAccessSequence || [];
  const seq = Array.isArray(seqCfg) ? seqCfg : (it.stockClass && seqCfg[it.stockClass]) || seqCfg['*'] || [];
  let chosen = null, selectedBy = 'DEFAULT';
  if (it.selectedCostId) { chosen = cands.find((c) => c.source.key === it.selectedCostId) || null; if (chosen) selectedBy = 'USER'; }
  if (!chosen) for (const sys of seq) { const c = cands.find((x) => x.source.system === sys); if (c) { chosen = c; selectedBy = `ACCESS_SEQUENCE:${sys}`; break; } }
  if (!chosen && cands.length) chosen = cands[0];
  if (!chosen) return missingLine(it, 'COST_PLUS', 'COST_MISSING', `No cost candidate for ${it.partNumber} in ${R.region}.`, { stockClass: it.stockClass });
  const costCandidates = cands.map((c) => ({ ...c, won: c === chosen, reason: c === chosen ? (selectedBy === 'USER' ? 'picked by user' : selectedBy.startsWith('ACCESS') ? `first system in the ${it.stockClass || 'default'} cost order` : 'default candidate') : seq.includes(c.source.system) ? `later in cost order (${seq.indexOf(c.source.system) + 1} of ${seq.length})` : 'system not in cost order' }));

  const scope = { item: it };
  const values = {}; const steps = []; let running = 0; const qty = it.quantity;
  for (const el of R.buildUp) {
    if (el.when && !evalWhen(el.when, scope)) { values[el.id] = 0; steps.push(step(el.id, el.type, 0, running, { skipped: true, when: el.when })); continue; }
    let delta; let note;
    if (el.type === 'BASE') { delta = Number(chosen.value); note = { source: chosen.source.system }; }
    else if (el.type === 'FACTOR') {
      const basisAmount = (el.basis || []).reduce((s, b) => s + (values[b] || 0), 0);
      const rate = el.rate !== undefined && el.rate !== null ? Number(el.rate) : elements[el.rateRef];
      if (rate === undefined || rate === null) return missingLine(it, 'COST_PLUS', 'RATE_MISSING', `${el.id}: no rate in part data field "${el.rateRef}".`, { steps, stockClass: it.stockClass });
      delta = basisAmount * rate; note = { basis: el.basis, basisAmount: s2(basisAmount), rate: String(rate), rateSource: el.rate !== undefined ? 'CONFIG' : el.rateRef };
    } else {
      const v = el.amount !== undefined && el.amount !== null ? Number(el.amount) : elements[el.amountRef];
      if (v == null) return missingLine(it, 'COST_PLUS', 'AMOUNT_MISSING', `${el.id}: no amount in part data field "${el.amountRef}".`, { steps, stockClass: it.stockClass });
      if (el.type === 'PER_LINE') { delta = v / qty; note = { source: el.amount !== undefined ? 'CONFIG' : el.amountRef, perQuantity: qty, amount: String(v) }; }
      else { delta = v; note = { source: el.amount !== undefined ? 'CONFIG' : el.amountRef }; }
    }
    values[el.id] = delta; running += delta; steps.push(step(el.id, el.type, delta, running, note));
  }
  let quantity = qty; const constraintPasses = [];
  for (const c of R.constraints || []) {
    const min = c.min !== undefined && c.min !== null ? Number(c.min) : elements[c.minRef];
    if (min == null) continue;
    if (c.kind === 'FLOOR' && running * quantity < min) {
      if (c.mode === 'QUANTITY') { const nq = Math.ceil(min / running); constraintPasses.push({ id: c.id, kind: 'FLOOR', mode: 'QUANTITY', min: String(min), quantityFrom: quantity, quantityTo: nq }); quantity = nq; }
      else { const adj = min / quantity; constraintPasses.push({ id: c.id, kind: 'FLOOR', mode: 'PRICE', min: String(min), from: s2(running), to: s2(adj) }); running = adj; }
    }
    if (c.kind === 'MIN_QTY' && quantity < min) constraintPasses.push({ id: c.id, kind: 'MIN_QTY', min: String(min), quantity, warning: `Requested quantity ${quantity} is below the minimum order quantity ${min}.` });
  }
  const landed = running;
  const margin = it.marginOverride !== undefined && it.marginOverride !== null && it.marginOverride !== '' ? Number(it.marginOverride) : R.sell?.defaultMargin ?? null;
  if (margin !== null && (margin >= 1 || margin < 0)) return missingLine(it, 'COST_PLUS', 'MARGIN_INVALID', `A sell margin of ${margin} cannot price (must be below 100%).`, { steps, stockClass: it.stockClass });
  const unitPrice = margin === null ? landed : landed / (1 - margin);
  return {
    partNumber: it.partNumber, status: 'PRICED', technique: 'COST_PLUS', book: null,
    result: { unitPrice: s2(unitPrice), landedCost: s2(landed), margin: margin === null ? null : String(margin), currency: R.currency, quantity },
    trace: { technique: 'COST_PLUS', region: R.region, configVersion: R.version, costCandidate: { ...chosen, selectedBy }, costCandidates, accessSequence: seq, selectedBy, stockClass: it.stockClass || null, steps, constraintPasses, notes, sell: margin === null ? null : { margin: String(margin), source: it.marginOverride !== undefined && it.marginOverride !== null && it.marginOverride !== '' ? 'LINE_OVERRIDE' : 'REGION_DEFAULT', landedCost: s2(landed) }, resolvedItem: { supplier: it.supplier || null, supplierCountry: it.supplierCountry || null, warehouse: it.warehouse || null, ood: it.ood || null } },
  };
}

function pricePriceList(item, ctx, book) {
  const part = PARTS[item.partNumber]; const qty = Number(item.quantity) || 1;
  const attrs = { ...part, customer: ctx.customerId, tier: ctx.tier, region: ctx.region, salesOrg: ctx.salesOrg };
  const rows = (book.rows || []).filter((r) => r.part === item.partNumber);
  if (!rows.length) return missingLine(item, 'PRICE_LIST', 'NO_LIST_PRICE', `${item.partNumber} has no row in the ${book.name} price list.`, { book: book.id });
  const res = resolveRows(rows, attrs, book.dimensions || [], ctx.priceDate);
  const summary = { ambiguous: res.ambiguous, candidates: res.candidates.map((c) => ({ match: c.row.match || {}, description: describeMatch(c.row.match), specificity: c.specificity, tiers: c.row.tiers, validFrom: c.row.validFrom || null, validTo: c.row.validTo || null, won: c.won, reason: c.reason })) };
  if (!res.winner) return missingLine(item, 'PRICE_LIST', 'NO_MATCHING_ROW', `No price list row applies to this customer/region on ${ctx.priceDate}.`, { book: book.id, resolution: summary });
  if (res.ambiguous) return missingLine(item, 'PRICE_LIST', 'AMBIGUOUS_RULE', 'Two rows match with equal specificity — fix the price list.', { book: book.id, resolution: summary });
  const tier = tierValue(res.winner.row.tiers, qty);
  if (!tier) return missingLine(item, 'PRICE_LIST', 'NO_TIER', `Quantity ${qty} is below the first tier of the matching row.`, { book: book.id, resolution: summary });
  const steps = []; let running = Number(tier.value);
  steps.push(step('LIST_PRICE', 'RULE', running, running, { row: describeMatch(res.winner.row.match), specificity: res.winner.specificity, tierFrom: tier.from, source: 'PRICE_LIST' }));
  const disc = resolveRows(book.discount, attrs, book.dimensions || [], ctx.priceDate);
  const dv = disc.winner ? Number(disc.winner.row.value) : 0;
  if (dv === 0) steps.push(step('CUST_DISC', 'PERCENT', 0, running, { skipped: true, reason: disc.winner ? 'RATE_ZERO' : 'NO_MATCHING_ROW' }));
  else { const dd = -running * dv; running += dd; steps.push(step('CUST_DISC', 'PERCENT', dd, running, { rate: String(dv), row: describeMatch(disc.winner.row.match), basis: ['LIST_PRICE'] })); }
  const constraintPasses = [];
  for (const c of book.constraints || []) if (c.kind === 'FLOOR' && running * qty < Number(c.min)) { const adj = Number(c.min) / qty; constraintPasses.push({ id: c.id, kind: 'FLOOR', mode: 'PRICE', min: String(c.min), from: s2(running), to: s2(adj) }); running = adj; }
  return { partNumber: item.partNumber, status: 'PRICED', technique: 'PRICE_LIST', book: book.id, result: { unitPrice: s2(running), landedCost: null, margin: null, currency: book.currency, quantity: qty }, trace: { technique: 'PRICE_LIST', book: book.id, bookVersion: book.version, attributes: { customer: attrs.customer, tier: attrs.tier, region: attrs.region, salesOrg: attrs.salesOrg }, resolution: summary, tier: { from: tier.from, value: String(tier.value) }, steps, constraintPasses } };
}

function inForce(input, date) {
  const list = Array.isArray(input) ? input : [input];
  return list.find((v) => (!v.validFrom || v.validFrom <= date) && (!v.validTo || date < v.validTo)) || null;
}
function priceCatalog(item, ctx, book) {
  const part = PARTS[item.partNumber]; const qty = Number(item.quantity) || 1;
  const attrs = { tier: ctx.tier, region: ctx.region, customer: ctx.customerId };
  const matchOn = book.matchOn || ['spec', 'variant'];
  const checked = (book.rows || []).map((row, index) => ({ index, match: row.match || {}, rate: String(row.rate), ok: matchOn.every((k) => part[k] !== undefined && String(part[k]) === String((row.match || {})[k])) }));
  const hit = checked.find((c) => c.ok);
  const steps = []; let running; let source; let formula = null; let costInputs = null;
  if (hit) { running = Number(hit.rate); source = 'CATALOG'; steps.push(step('CATALOG_RATE', 'RULE', running, running, { row: describeMatch(hit.match), source: 'CATALOG' })); }
  else {
    if (!book.fallbackFormula) return missingLine(item, 'CATALOG_FORMULA', 'NO_CATALOG_ROW', `No catalog row for ${matchOn.map((k) => `${k}=${part[k]}`).join(', ')} and the book has no fallback formula.`, { book: book.id, checked });
    let parsed; try { parsed = parseFormula(book.fallbackFormula); } catch (e) { return missingLine(item, 'CATALOG_FORMULA', 'FORMULA_INVALID', e.message, { book: book.id, checked, formula: book.fallbackFormula }); }
    costInputs = {}; const cost = {};
    for (const v of parsed.variables.filter((x) => x.startsWith('cost.'))) {
      const name = v.slice(5); const def = book.costInputs?.[name];
      if (!def) return missingLine(item, 'CATALOG_FORMULA', 'FORMULA_INPUT_MISSING', `The formula uses ${v} but the book has no such cost input.`, { book: book.id, checked, formula: book.fallbackFormula, variable: v });
      const cur = inForce(def, ctx.priceDate);
      if (!cur) return missingLine(item, 'CATALOG_FORMULA', 'COST_INPUT_NOT_IN_FORCE', `${v} has no value in force on ${ctx.priceDate}.`, { book: book.id, checked, formula: book.fallbackFormula, variable: v });
      cost[name] = cur.value; costInputs[v] = { value: String(cur.value), unit: cur.unit || def.unit || null, validFrom: cur.validFrom || null, validTo: cur.validTo || null, source: cur.source || 'MANUAL', confidence: cur.source === 'AI_DERIVED' ? 'FALLBACK' : 'EXACT' };
    }
    const used = {}; let value;
    try { value = evalAst(parsed.ast, { ...part, quantity: qty, cost }, used); } catch (e) { return missingLine(item, 'CATALOG_FORMULA', 'FORMULA_INPUT_MISSING', e.message, { book: book.id, checked, formula: book.fallbackFormula, variable: e.variable }); }
    running = value; source = 'FORMULA'; formula = { source: book.fallbackFormula, used, value: s2(value) };
    steps.push(step('FORMULA_COST', 'FORMULA', running, running, { formula: book.fallbackFormula, used, source: 'FORMULA' }));
  }
  const freight = Number(book.freight || 0);
  if (freight === 0) steps.push(step('FREIGHT', 'ADDER', 0, running, { skipped: true, reason: 'NO_FREIGHT' })); else { running += freight; steps.push(step('FREIGHT', 'ADDER', freight, running, { source: 'CONFIG' })); }
  const landed = running; let marginRate = null; let floor = null;
  const dims = [{ attr: 'customer', weight: 100 }, { attr: 'tier', weight: 30 }, { attr: 'region', weight: 20 }];
  if (source === 'FORMULA') {
    const m = resolveRows(book.margin, attrs, dims, ctx.priceDate);
    if (m.ambiguous) return missingLine(item, 'CATALOG_FORMULA', 'AMBIGUOUS_RULE', 'Two margin rows match with equal specificity.', { book: book.id, checked });
    marginRate = m.winner ? Number(m.winner.row.value) : 0; const md = landed * marginRate; running += md;
    steps.push(step('MARGIN', 'PERCENT', md, running, { rate: String(marginRate), basis: ['FORMULA_COST', 'FREIGHT'], row: m.winner ? describeMatch(m.winner.row.match) : 'none' }));
  } else steps.push(step('MARGIN', 'PERCENT', 0, running, { skipped: true, reason: 'CATALOG_RATE_IS_SELL_PRICE' }));
  const d = resolveRows(book.discount, attrs, dims, ctx.priceDate);
  if (d.ambiguous) return missingLine(item, 'CATALOG_FORMULA', 'AMBIGUOUS_RULE', 'Two discount rows match with equal specificity.', { book: book.id, checked });
  const dv = d.winner ? Number(d.winner.row.value) : 0;
  if (dv === 0) steps.push(step('CUST_DISC', 'PERCENT', 0, running, { skipped: true, reason: d.winner ? 'RATE_ZERO' : 'NO_MATCHING_ROW' })); else { const dd = -running * dv; running += dd; steps.push(step('CUST_DISC', 'PERCENT', dd, running, { rate: String(dv), row: describeMatch(d.winner.row.match) })); }
  let realised = null;
  if (source === 'FORMULA') { realised = (running - landed) / landed; floor = { rate: String(book.floor ?? 0), realised: String(r2(realised * 10000) / 10000), breached: realised < Number(book.floor ?? 0) }; }
  return { partNumber: item.partNumber, status: 'PRICED', technique: 'CATALOG_FORMULA', book: book.id, result: { unitPrice: s2(running), landedCost: source === 'FORMULA' ? s2(landed) : null, margin: realised === null ? null : String(Math.round(realised * 10000) / 10000), currency: book.currency, quantity: qty }, trace: { technique: 'CATALOG_FORMULA', book: book.id, bookVersion: book.version, source, checked, formula, costInputs, marginRate: marginRate === null ? null : String(marginRate), floor, attributes: attrs, steps, constraintPasses: [] } };
}

function flagsFor(line) {
  if (line.status !== 'PRICED') return [{ level: 'crit', code: line.missing?.reason || line.status, text: line.missing?.detail || line.status }];
  const t = line.trace; const flags = [];
  if (t.costCandidate && t.costCandidate.confidence !== 'EXACT') flags.push({ level: 'warn', code: 'COST_CONFIDENCE', text: `Cost confidence is ${t.costCandidate.confidence} — a binding quote needs a confirmed cost.` });
  for (const p of t.constraintPasses || []) {
    if (p.kind === 'MIN_QTY') flags.push({ level: 'warn', code: 'BELOW_MOQ', text: p.warning });
    else if (p.kind === 'FLOOR') flags.push({ level: 'info', code: 'MOLV_APPLIED', text: p.mode === 'QUANTITY' ? `Minimum order line value ${p.min}: quantity raised ${p.quantityFrom} → ${p.quantityTo}.` : `Minimum order line value ${p.min}: unit price raised to ${p.to}.` });
  }
  if (t.technique === 'CATALOG_FORMULA') {
    if (t.source === 'FORMULA') flags.push({ level: 'info', code: 'PRICED_BY_FORMULA', text: 'No negotiated rate exists for this size — priced by the fallback formula.' });
    if (t.floor?.breached) flags.push({ level: 'crit', code: 'MARGIN_FLOOR', text: `Margin ${(Number(t.floor.realised) * 100).toFixed(1)}% is below the ${(Number(t.floor.rate) * 100).toFixed(0)}% floor after discount — needs pricing approval.` });
    for (const [name, p] of Object.entries(t.costInputs || {})) if (p.confidence && p.confidence !== 'EXACT') flags.push({ level: 'warn', code: 'COST_INPUT_CONFIDENCE', text: `Cost input ${name} is ${p.confidence} (${p.source}).` });
  }
  if (t.technique === 'PRICE_LIST' && t.resolution) { const won = t.resolution.candidates.find((c) => c.won); if (won?.validTo) flags.push({ level: 'info', code: 'ROW_EXPIRES', text: `The matching price list row is valid until ${won.validTo}.` }); }
  return flags;
}

function resolveTechnique(item, part, cfg, ctx) {
  const fits = (book) => Object.entries(book?.appliesWhen || {}).every(([k, v]) => (k === 'region' ? ctx.region === v : String(part[k]) === String(v)));
  if (item.pricingType) {
    if (item.pricingType === 'COST_PLUS') return { technique: 'COST_PLUS', book: null, routedBy: 'USER' };
    const books = item.pricingType === 'PRICE_LIST' ? cfg.priceLists : cfg.catalogs;
    const book = item.book && books[item.book] ? books[item.book] : Object.values(books).find(fits);
    if (!book) return { technique: item.pricingType, book: null, routedBy: 'USER', missing: { reason: 'NO_BOOK', detail: `No ${item.pricingType === 'PRICE_LIST' ? 'price list' : 'catalog'} applies to this line in ${ctx.region}.` } };
    return { technique: item.pricingType, book: book.id, routedBy: 'USER' };
  }
  (cfg.routing?.rules || []).forEach(() => {});
  for (let i = 0; i < (cfg.routing?.rules || []).length; i++) {
    const r = cfg.routing.rules[i];
    if (!Object.entries(r.when || {}).every(([k, v]) => String(part[k]) === String(v))) continue;
    const book = (r.type === 'PRICE_LIST' ? cfg.priceLists : cfg.catalogs)[r.book];
    if (book && fits(book)) return { technique: r.type, book: r.book, routedBy: `RULE:${i}` };
  }
  return { technique: 'COST_PLUS', book: null, routedBy: 'DEFAULT' };
}

function resolveConfig(ctx, overrides) {
  const asOf = ctx.priceDate;
  const wildcard = (key) => (String(key).includes('::') ? `${String(key).slice(0, String(key).lastIndexOf('::'))}::*` : null);
  const ov = (kind, key, live) => {
    const o = overrides.find((d) => d.kind === kind && d.key === key) || overrides.find((d) => d.kind === kind && d.key === wildcard(key) && (!live || live.salesOrg === '*'));
    return o ? o.doc : live;
  };
  const region = ov('region-config', `${ctx.region}::${ctx.salesOrg || '*'}`, effective('region-config', `${ctx.region}::${ctx.salesOrg || '*'}`, asOf));
  const books = (kind) => Object.fromEntries(state.docs.filter((d) => d.kind === kind).map((d) => d.key).filter((k, i, a) => a.indexOf(k) === i).map((k) => [k, ov(kind, k, effective(kind, k, asOf))]).filter(([, v]) => v));
  const suppliers = Object.fromEntries(state.docs.filter((d) => d.kind === 'supplier-config').map((d) => d.key).filter((k, i, a) => a.indexOf(k) === i).map((k) => [k, effective('supplier-config', k, asOf)]).filter(([, v]) => v));
  return { region, priceLists: books('price-list'), catalogs: books('catalog-book'), routing: ov('routing-rules', '*', effective('routing-rules', '*', asOf)) || { rules: [] }, suppliers };
}

function contextOf(payload) {
  const customerId = payload.customerId || payload.party?.customerId || null;
  const priceDate = payload.priceDate || today();
  const party = customerId ? effective('party-config', customerId, priceDate) : null;
  const salesOrg = payload.salesOrg || payload.party?.salesOrg || '*';
  let region = payload.region || null; let entityLabel = null;
  const route = party?.customerOod ? effective('region-route', `${party.customerOod}::${salesOrg}`, priceDate) : null;
  if (!region && route) region = route.region;
  if (route && route.region === region) entityLabel = route.entityLabel;
  return { customerId, tier: party?.tier ?? null, salesOrg, region, entityLabel, priceDate, purpose: payload.context?.purpose || payload.purpose || 'INDICATIVE' };
}

function priceLines(items, ctx, overrides = []) {
  const cfg = resolveConfig(ctx, overrides);
  if (!cfg.region) fail(422, `No region-config is in force for ${ctx.region || '(no region)'} on ${ctx.priceDate}.`, 'NO_REGION_CONFIG');
  return items.map((item) => {
    const part = PARTS[item.partNumber];
    let line;
    if (!part) line = missingLine(item, 'COST_PLUS', 'UNKNOWN_PART', `${item.partNumber} is not in the item master.`);
    else {
      const route = resolveTechnique(item, part, cfg, ctx);
      if (route.missing) line = missingLine(item, route.technique, route.missing.reason, route.missing.detail);
      else if (route.technique === 'PRICE_LIST') line = pricePriceList(item, ctx, cfg.priceLists[route.book]);
      else if (route.technique === 'CATALOG_FORMULA') line = priceCatalog(item, ctx, cfg.catalogs[route.book]);
      else line = priceCostPlus(item, ctx, cfg);
      line.technique = route.technique; line.book = route.book; line.routedBy = route.routedBy;
      line.trace = { ...line.trace, technique: route.technique, routedBy: route.routedBy };
    }
    line.trace = { ...line.trace, priceDate: ctx.priceDate, region: ctx.region, configVersions: { region: cfg.region.version, routing: cfg.routing.version || null } };
    line.flags = flagsFor(line);
    return line;
  });
}

/* ── AI stand-in: two sentence patterns → a proposed document ───────────── */
function propose(instruction, kind, key, base) {
  const doc = clone(base);
  let m;
  if (kind === 'region-config' && (m = instruction.match(/set\s+([\w ]+?)\s+(?:rate\s+)?to\s+([\d.]+)\s*%/i))) {
    const id = m[1].trim().toUpperCase().replace(/\s+/g, '_');
    if (/default\s*margin|sell\s*margin/i.test(m[1])) { doc.sell = { ...(doc.sell || {}), defaultMargin: Number(m[2]) / 100 }; return { doc, summary: `Change ${doc.region} default sell margin from ${(base.sell?.defaultMargin ?? 0) * 100}% to ${m[2]}%.` }; }
    const el = doc.buildUp.find((e) => e.id === id);
    if (el && el.rate !== undefined) { el.rate = Number(m[2]) / 100; return { doc, summary: `Change ${doc.region} · ${id} rate from ${base.buildUp.find((e) => e.id === id).rate * 100}% to ${m[2]}%. Basis stays ${el.basis.join(' + ')}.` }; }
    return { error: `${doc.region} has no editable factor called ${id}.` };
  }
  if (kind === 'catalog-book' && (m = instruction.match(/set\s+(?:margin\s+)?floor\s+to\s+([\d.]+)\s*%/i))) { doc.floor = String(Number(m[1]) / 100); return { doc, summary: `Change ${doc.name} margin floor from ${Number(base.floor) * 100}% to ${m[1]}%.` }; }
  if (kind === 'price-list' && (m = instruction.match(/set\s+([\w-]+)\s+(?:default\s+)?price\s+to\s+([\d.]+)/i))) {
    const row = doc.rows.find((r) => r.part.toUpperCase() === m[1].toUpperCase() && Object.keys(r.match || {}).length === 0);
    if (row) { row.tiers[0].value = String(m[2]); return { doc, summary: `Change ${doc.name} · ${row.part} default price (from qty 0) to ${m[2]}.` }; }
    return { error: `${doc.name} has no default row for ${m[1]}.` };
  }
  return { error: 'Could not map the sentence to a rule. Try “Set SCM_MARKUP to 5%”, “Set default margin to 28%”, “Set floor to 15%” or “Set OR-25X3-NBR default price to 1.25”.' };
}

/* ── handlers ───────────────────────────────────────────────────────────── */
const requireAdmin = (user) => { if (!USERS[user]?.roles.includes('PricingAdmin')) fail(403, `User ${user} lacks the PricingAdmin role.`, 'FORBIDDEN'); };
const listItems = (payload) => (payload.items || []).map((i) => ({ ...i, quantity: Number(i.quantity) || 1 }));

const handlers = {
  'GET /rest/pricing/whoami': (q, user) => USERS[user] || fail(401, 'Unknown user.'),
  'POST /rest/pricing/price': (p, user) => {
    const ctx = contextOf(p);
    if (!ctx.region) fail(422, 'No region given and the customer has no region route.', 'NO_REGION');
    const items = priceLines(listItems(p), ctx);
    state.seq += 1;
    const documentId = `PD-${ctx.priceDate}-${String(state.seq).padStart(4, '0')}`;
    const doc = { ID: documentId, requestedBy: user, hostSystem: p.context?.hostSystem || 'APP', hostObjectType: p.context?.hostObjectType || null, hostObjectId: p.context?.hostObjectId || null, purpose: ctx.purpose, region: ctx.region, salesOrg: ctx.salesOrg, priceDate: ctx.priceDate, configVersions: items[0]?.trace.configVersions || {}, request: p, result: { items }, createdAt: new Date().toISOString() };
    state.pricingDocs.push(doc);
    return { config: doc.configVersions, region: ctx.region, entityLabel: ctx.entityLabel, priceDate: ctx.priceDate, requestedBy: user, documentId, items };
  },
  'POST /rest/pricing/fetchItemAttributes': (p) => {
    const attributes = {};
    for (const it of listItems(p)) {
      const part = PARTS[it.partNumber];
      if (!part) { attributes[it.partNumber] = null; continue; }
      const sup = it.supplier ? effective('supplier-config', it.supplier, p.priceDate) : null;
      const region = p.region ? effective('region-config', `${p.region}::*`, p.priceDate) : null;
      attributes[it.partNumber] = { description: part.description, family: part.family, spec: part.spec ?? null, variant: part.variant ?? null, diameter_mm: part.diameter_mm ?? null, supplier: it.supplier || null, supplierCountry: it.supplierCountry || sup?.supplierCountry || null, warehouse: it.warehouse || null, stockClass: it.stockClass || (region?.stockClassMap && part.stockClassRaw ? region.stockClassMap[part.stockClassRaw] || null : null), stockClassRaw: part.stockClassRaw || null };
    }
    return { attributes };
  },
  'GET /rest/pricing/getPricingDocument': (q) => state.pricingDocs.find((d) => d.ID === q.id) || fail(404, `No pricing document ${q.id}.`),
  'GET /rest/pricing/listPricingDocuments': (q) => ({ documents: state.pricingDocs.filter((d) => !q.hostObjectId || d.hostObjectId === q.hostObjectId).slice(-(Number(q.limit) || 50)).map(({ result, request, ...rest }) => ({ ...rest, lines: result.items.length, itemCount: request.items?.length })) }),
  'POST /rest/pricing/simulate': (p) => {
    const refs = [...(p.drafts || []), ...(p.draft ? [p.draft] : [])].filter((d, i, a) => a.findIndex((x) => x.kind === d.kind && x.key === d.key) === i);
    if (!refs.length) fail(422, 'simulate needs a draft reference.', 'NO_DRAFT');
    const overrides = refs.map((ref) => { const d = state.docs.find((x) => x.kind === ref.kind && x.key === ref.key && String(x.version) === String(ref.version)); if (!d) fail(404, `No ${ref.kind} ${ref.key} v${ref.version}.`); return { kind: ref.kind, key: ref.key, doc: d.doc }; });
    const ctx = contextOf(p);
    let items = listItems(p);
    for (const id of p.documentIds || []) { const d = state.pricingDocs.find((x) => x.ID === id); if (d) items = items.concat(listItems(d.request)); }
    const live = priceLines(items, ctx); const draft = priceLines(items, ctx, overrides);
    const total = (l) => (l.status === 'PRICED' ? Number(l.result.unitPrice) * Number(l.result.quantity) : null);
    const lines = live.map((l, i) => { const a = draft[i]; const lt = total(l), dt = total(a); return { partNumber: l.partNumber, live: l, draft: a, lineTotalLive: lt === null ? null : s2(lt), lineTotalDraft: dt === null ? null : s2(dt), delta: lt !== null && dt !== null ? s2(dt - lt) : null }; });
    const sum = (arr) => arr.reduce((s, l) => s + (total(l) ?? 0), 0);
    return { drafts: refs, region: ctx.region, priceDate: ctx.priceDate, items: lines, totals: { live: s2(sum(live)), draft: s2(sum(draft)), delta: s2(sum(draft) - sum(live)), currency: live.find((l) => l.result)?.result.currency || null }, floorCrossings: lines.filter((l) => l.draft.status === 'PRICED' && l.draft.flags.some((f) => f.code === 'MARGIN_FLOOR') && !l.live.flags.some((f) => f.code === 'MARGIN_FLOOR')).map((l) => l.partNumber), deadRows: [] };
  },
  'GET /rest/config/getEffective': (q) => effective(q.kind, q.key, q.asOf) || fail(404, `No effective ${q.kind} "${q.key}" on ${q.asOf || today()}.`, 'NOT_FOUND'),
  'GET /rest/config/listVersions': (q) => ({ versions: bucket(q.kind, q.key).map((d) => d.doc) }),
  'GET /rest/config/getVersion': (q) => bucket(q.kind, q.key).find((d) => String(d.version) === String(q.version))?.doc || fail(404, `No version ${q.version}.`),
  'GET /rest/config/diff': (q) => {
    const find = (v) => bucket(q.kind, q.key).find((d) => String(d.version) === String(v))?.doc || fail(404, `No version ${v} of ${q.kind} ${q.key}.`);
    return { kind: q.kind, key: q.key, a: q.a, b: q.b, changes: diffDocs(find(q.a), find(q.b)) };
  },
  'GET /rest/config/listBooks': (q) => ({ books: [...new Set(state.docs.filter((d) => d.kind === q.kind).map((d) => d.key))].map((k) => { const doc = effective(q.kind, k) || bucket(q.kind, k).at(-1).doc; return { id: k, name: doc.name, currency: doc.currency, appliesWhen: doc.appliesWhen, version: doc.version, status: doc.status }; }) }),
  'GET /rest/config/listSuppliers': (q) => ({ suppliers: [...new Set(state.docs.filter((d) => d.kind === 'supplier-config').map((d) => d.key))].map((k) => effective('supplier-config', k, q.asOf)).filter(Boolean) }),
  'GET /rest/config/listSuggestions': (q) => ({ suggestions: state.suggestions.filter((s) => !q.status || s.status === q.status) }),
  'GET /rest/config/validateFormula': (q) => {
    try {
      const { variables } = parseFormula(q.formula || '');
      const book = q.key ? effective(q.kind || 'catalog-book', q.key) : null;
      const missing = book ? variables.filter((v) => v.startsWith('cost.') && !book.costInputs?.[v.slice(5)]) : [];
      if (missing.length) return { valid: false, message: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not defined under cost inputs.`, variables };
      return { valid: true, message: `Valid — uses ${variables.join(', ') || 'no variables'}.`, variables };
    } catch (e) { return { valid: false, message: e.message, variables: [] }; }
  },
  'POST /rest/config/saveDraft': (p, user) => {
    requireAdmin(user);
    if (!p?.kind || !p?.doc) fail(422, 'saveDraft needs { kind, doc }.');
    const key = keyOf(p.kind, p.doc);
    const existing = p.doc.version ? bucket(p.kind, key).find((d) => String(d.version) === String(p.doc.version)) : null;
    if (existing && existing.status !== 'DRAFT') fail(422, `Version "${p.doc.version}" already exists for ${p.kind} "${key}".`, 'VERSION_EXISTS');
    const version = p.doc.version || nextVersion(p.kind, key);
    const doc = { ...stripEnvelope(p.doc), version, status: 'DRAFT', validFrom: p.doc.validFrom || today(), validTo: p.doc.validTo ?? null, supersedes: p.doc.supersedes ?? null, provenance: { source: 'HUMAN', authoredBy: user, authoredAt: new Date().toISOString() } };
    if (p.kind === 'routing-rules') doc.key = '*';
    if (existing) Object.assign(existing, { doc, validFrom: doc.validFrom }); else state.docs.push({ kind: p.kind, key, version, status: 'DRAFT', validFrom: doc.validFrom, validTo: null, doc });
    return doc;
  },
  'POST /rest/config/publish': (p, user) => {
    requireAdmin(user);
    const d = state.docs.find((x) => x.kind === p.kind && x.key === p.key && String(x.version) === String(p.version)) || fail(404, `No version ${p.version} of ${p.kind} ${p.key}.`);
    if (d.status !== 'DRAFT') fail(422, `Version ${p.version} is ${d.status}, not DRAFT.`);
    const from = p.effectiveFrom || d.validFrom || today();
    for (const v of bucket(p.kind, p.key)) if (v.status === 'ACTIVE') { v.status = 'SUPERSEDED'; v.validTo = !v.validTo || v.validTo > from ? from : v.validTo; Object.assign(v.doc, { status: 'SUPERSEDED', validTo: v.validTo }); }
    const current = bucket(p.kind, p.key).find((v) => v.status === 'SUPERSEDED' && v.validTo === from);
    Object.assign(d, { status: 'ACTIVE', validFrom: from }); Object.assign(d.doc, { status: 'ACTIVE', validFrom: from, supersedes: current?.version ?? null, provenance: { ...d.doc.provenance, publishedBy: user, publishedAt: new Date().toISOString(), ...(p.note ? { note: p.note } : {}) } });
    return d.doc;
  },
  'POST /rest/config/discardDraft': (p, user) => {
    requireAdmin(user);
    const d = state.docs.find((x) => x.kind === p.kind && x.key === p.key && String(x.version) === String(p.version)) || fail(404, `No version ${p.version} of ${p.kind} ${p.key}.`);
    if (d.status !== 'DRAFT') fail(422, `Version ${p.version} is ${d.status} — only drafts can be discarded.`);
    d.status = 'REJECTED'; d.doc.status = 'REJECTED';
    return d.doc;
  },
  'POST /rest/config/saveActive': (p, user) => {
    requireAdmin(user);
    const draft = handlers['POST /rest/config/saveDraft']({ kind: p.kind, doc: { ...p.doc, version: undefined } }, user);
    return handlers['POST /rest/config/publish']({ kind: p.kind, key: keyOf(p.kind, draft), version: draft.version, effectiveFrom: p.effectiveFrom || p.doc.validFrom, note: p.note }, user);
  },
  'POST /rest/config/suggestChange': (p, user) => {
    requireAdmin(user);
    if (/unconfigured/i.test(p.instruction || '')) return { status: 'AI_NOT_CONFIGURED', message: 'No AI credential is configured on the server (ANTHROPIC_API_KEY missing).' };
    const base = p.version ? bucket(p.targetKind, p.targetKey).find((d) => String(d.version) === String(p.version))?.doc : effective(p.targetKind, p.targetKey);
    if (!base) fail(404, `No ${p.targetKind} "${p.targetKey}" to change.`);
    const out = propose(p.instruction || '', p.targetKind, p.targetKey, base);
    if (out.error) fail(422, out.error, 'SUGGESTION_UNMAPPED');
    const s = { id: `SUG-${String(state.suggestions.length + 1).padStart(3, '0')}`, status: 'PENDING_REVIEW', targetKind: p.targetKind, targetKey: p.targetKey, baseVersion: base.version, instruction: p.instruction, summary: out.summary, changes: diffDocs(base, out.doc), proposed: out.doc, requestedBy: user, createdAt: new Date().toISOString(), model: 'mock-rules-v0' };
    state.suggestions.unshift(s);
    return s;
  },
  'POST /rest/config/approveSuggestion': (p, user) => {
    requireAdmin(user);
    const s = state.suggestions.find((x) => x.id === p.suggestionId) || fail(404, `No suggestion ${p.suggestionId}.`);
    if (s.status !== 'PENDING_REVIEW') fail(422, `Suggestion ${s.id} is ${s.status}.`);
    // Approval lands on the open draft when there is one: re-apply the instruction to the
    // draft's current content instead of replacing it with a proposal built from the live doc.
    const open = bucket(s.targetKind, s.targetKey).filter((d) => d.status === 'DRAFT').at(-1);
    const applied = open ? propose(s.instruction, s.targetKind, s.targetKey, open.doc) : null;
    const proposed = applied && !applied.error ? applied.doc : s.proposed;
    const doc = handlers['POST /rest/config/saveDraft']({ kind: s.targetKind, doc: { ...proposed, version: open?.version } }, user);
    Object.assign(s, { status: 'APPROVED', reviewedBy: user, reviewedAt: new Date().toISOString(), draftVersion: doc.version });
    return { suggestion: s, draft: doc };
  },
  'POST /rest/config/rejectSuggestion': (p, user) => {
    requireAdmin(user);
    const s = state.suggestions.find((x) => x.id === p.suggestionId) || fail(404, `No suggestion ${p.suggestionId}.`);
    Object.assign(s, { status: 'REJECTED', reviewedBy: user, reviewedAt: new Date().toISOString(), reviewNotes: p.reviewNotes || null });
    return s;
  },
};

export async function handle(path, method, payload, user) {
  await new Promise((r) => setTimeout(r, 120));
  if (!USERS[user]) fail(401, 'Not authenticated.');
  const h = handlers[`${method} ${path}`];
  if (!h) fail(404, `No such endpoint ${method} ${path}.`, 'NOT_FOUND');
  return clone(h(payload || {}, user));
}
