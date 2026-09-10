/** Display helpers. Numbers arrive from the server as decimal strings — everything here
 *  formats, nothing here prices. The only arithmetic allowed in the browser is display
 *  math (line total = unit price × quantity, per-currency sums). */

export const TYPES = {
  COST_PLUS: { code: 'cp', label: 'Cost plus' },
  PRICE_LIST: { code: 'pl', label: 'Price list' },
  CATALOG_FORMULA: { code: 'cf', label: 'Catalog + formula' },
};

/** Plain-language labels for build-up primitives (owner decision 2026-08-26). */
export const TYPE_LABEL = { BASE: 'Base cost', FACTOR: 'Factor %', ADDER: 'Flat add', PER_LINE: 'Flat add ÷ order' };

export const CONSTRAINT_LABEL = {
  FLOOR: 'Minimum order line value',
  MIN_QTY: 'Minimum order quantity (warning)',
  STEP: 'Pack step',
};

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Two decimals, thousands-separated, optional currency suffix. '—' for nothing. */
export function fmt2(v, currency) {
  const n = num(v);
  if (n === null) return '—';
  const s = n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${s} ${currency}` : s;
}

/** A rate (0.047) as a percentage string ("4.7%"). */
export function pct(r) {
  const n = num(r);
  if (n === null) return '—';
  const p = n * 100;
  const rounded = Math.round(p * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)}%`;
}

/** Rate → editable percentage input value (0.047 → "4.7"). */
export function ratePctInput(r) {
  const n = num(r);
  if (n === null) return '';
  return String(Math.round(n * 10000) / 100);
}

/** Line total for display only. */
export function lineTotal(line) {
  if (!line || line.status !== 'PRICED' || !line.result) return null;
  const p = num(line.result.unitPrice);
  const q = num(line.result.quantity);
  return p === null || q === null ? null : p * q;
}

export function describeMatch(m) {
  const e = Object.entries(m || {});
  return e.length ? e.map(([k, v]) => `${k} = ${v}`).join(', ') : 'everyone (default)';
}

/** Σ weight of the dimensions a row's `match` names — the same number the engine ranks by. */
export function specificityOf(match, dimensions = []) {
  return Object.keys(match || {}).reduce((s, k) => s + (dimensions.find((d) => d.attr === k)?.weight ?? 10), 0);
}

export function whenText(w) {
  if (!w) return '';
  return Array.isArray(w) ? w.join(' AND ') : String(w);
}

/** `item.stockClass === 'NonMTS' AND item.includeLandedCost !== false` →
 *  `stockClass is NonMTS AND includeLandedCost allowed`. */
export function humanWhen(w) {
  const t = whenText(w);
  if (!t) return 'always';
  return t
    .replace(/item\./g, '')
    .replace(/ !== false/g, ' allowed')
    .replace(/===|==/g, 'is')
    .replace(/!==|!=/g, 'is not')
    .replace(/'/g, '');
}

export function stepName(id) {
  return String(id || '').replace(/_/g, ' ').toLowerCase();
}

export function statusChip(line) {
  if (!line) return null;
  if (line.status === 'MISSING') return { cls: 'crit', label: 'Missing' };
  if (line.status === 'BLOCKED') return { cls: 'crit', label: 'Blocked' };
  const flags = line.flags || [];
  if (flags.some((f) => f.level === 'crit')) return { cls: 'crit', label: 'Needs approval' };
  if (flags.some((f) => f.level === 'warn')) return { cls: 'warn', label: 'Check' };
  return { cls: 'good', label: 'Priced' };
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function clone(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
}

/** Keep the server's value type when a user edits a number: a decimal string stays a
 *  string, a JSON number stays a number. */
export function sameType(prev, next) {
  if (next === null || next === undefined) return next;
  return typeof prev === 'string' ? String(next) : Number(next);
}

/** Turn a diff path like `buildUp.2.rate` into `SCM_MARKUP · rate` when the working
 *  document can name the array element. Generic on purpose — no per-kind branches. */
export function humanPath(path, doc) {
  const parts = String(path).split(/[./]/).filter((p) => p !== '');
  let cur = doc;
  const out = [];
  for (const p of parts) {
    const next = cur && typeof cur === 'object' ? cur[p] : undefined;
    if (/^\d+$/.test(p) && next && typeof next === 'object') {
      const label = next.id || next.part || next.spec || (next.match && describeMatch(next.match)) || next.attr || `#${Number(p) + 1}`;
      out.push(String(label));
    } else if (/^\d+$/.test(p)) {
      out.push(`#${Number(p) + 1}`);
    } else {
      out.push(p);
    }
    cur = next;
  }
  return out.join(' · ');
}

export function fmtDiffValue(v) {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  const n = Number(v);
  if (typeof v !== 'boolean' && Number.isFinite(n) && Math.abs(n) < 1 && n !== 0 && String(v).includes('.')) return `${v} (${pct(v)})`;
  return String(v);
}
