/** Attribute rules, resolved most-specific-wins (ARCHITECTURE_V2 §2.3).
 *
 *  A row `{ match: { tier: 'A', region: 'EUROPE' }, ... }` applies to a context when every
 *  attribute in `match` equals the context's value. Specificity is the sum of the weights
 *  of the dimensions the row names; the highest specificity wins. Two live rows with equal
 *  specificity are AMBIGUOUS — a typed outcome the caller turns into MISSING, never a coin
 *  toss on array order. Validity (`validFrom`/`validTo`, dates as YYYY-MM-DD) is checked
 *  against the pricing date so a historical quote resolves the rows that were live then. */

const UNDECLARED_DIMENSION_WEIGHT = 1;

function specificity(match, dimensions) {
  return Object.keys(match || {}).reduce((sum, attr) => {
    const dim = (dimensions || []).find((d) => d.attr === attr);
    return sum + (dim ? Number(dim.weight) : UNDECLARED_DIMENSION_WEIGHT);
  }, 0);
}

function rowMatches(match, ctx) {
  return Object.entries(match || {}).every(([attr, value]) => {
    const actual = ctx[attr];
    if (actual === undefined || actual === null) return false;
    return String(actual) === String(value);
  });
}

function inValidity(row, date) {
  if (!date) return true;
  if (row.validFrom && row.validFrom > date) return false;
  if (row.validTo && row.validTo < date) return false;
  return true;
}

/** Returns { winner, candidates, ambiguous }. `candidates` carries every row's fate so the
 *  trace can show the rows that were considered and why each lost. */
function resolveRows(rows, ctx, dimensions, date) {
  const candidates = (rows || []).map((row, index) => {
    const matched = rowMatches(row.match, ctx);
    const inDate = inValidity(row, date);
    return {
      index,
      row,
      matched,
      inDate,
      specificity: specificity(row.match, dimensions),
      won: false,
      reason: !inDate ? 'OUTSIDE_VALIDITY' : !matched ? 'CONDITION_NOT_MET' : null,
    };
  });

  const live = candidates.filter((c) => c.matched && c.inDate).sort((a, b) => b.specificity - a.specificity);
  const winner = live[0] || null;
  const ambiguous = live.length > 1 && live[1].specificity === winner.specificity;

  for (const c of live) {
    if (c === winner) c.won = !ambiguous;
    else c.reason = `LESS_SPECIFIC:${c.specificity}<${winner.specificity}`;
  }
  if (ambiguous) {
    for (const c of live.filter((x) => x.specificity === winner.specificity)) c.reason = 'AMBIGUOUS';
  }

  return { winner: ambiguous ? null : winner, candidates, ambiguous };
}

/** Quantity tiers `[ { from, value }, ... ]`: the tier with the highest `from` <= quantity.
 *  Returns null when quantity is below every tier (a tier list should start at 0). */
function tierValue(tiers, quantity) {
  const qty = Number(quantity);
  return [...(tiers || [])]
    .filter((t) => Number(t.from) <= qty)
    .sort((a, b) => Number(b.from) - Number(a.from))[0] || null;
}

function describeMatch(match) {
  const entries = Object.entries(match || {});
  return entries.length ? entries.map(([k, v]) => `${k} = ${v}`).join(', ') : 'default';
}

module.exports = { specificity, rowMatches, inValidity, resolveRows, tierValue, describeMatch };
