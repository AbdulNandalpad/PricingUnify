/** Flat document diff (ARCHITECTURE_V2 §3.3): `[{ path, from, to }]` for any two config
 *  documents — the "Changes in this draft" table and the version compare view. Paths are
 *  JSON-pointer style (`/rows/2/tiers/1/value`); a value present on one side only shows the
 *  other side as undefined. Arrays are compared by index — a config document's arrays are
 *  ordered (build-up sequence, rule precedence), so a reorder IS a change. */
function diff(a, b, { ignore = [] } = {}) {
  const out = [];
  walk(a, b, '', out);
  return ignore.length ? out.filter((d) => !ignore.some((p) => d.path === p || d.path.startsWith(`${p}/`))) : out;
}

function walk(a, b, path, out) {
  if (isObject(a) && isObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path}/${escape(key)}`, out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) walk(a[i], b[i], `${path}/${i}`, out);
    return;
  }
  if (!same(a, b)) out.push({ path: path || '/', from: a, to: b });
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function same(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function escape(key) {
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

module.exports = { diff };
