const { KINDS, isKind, WILDCARD } = require('@tss-pricing/config-model');

const COMPOSITE_KINDS = new Set(['region-config', 'region-route']);

/**
 * Normalizes the document key a caller sends into ConfigStore's canonical docKey.
 * Callers spell composite keys three ways — `EUROPE::DE01` (config-model), `EUROPE/DE01`
 * (MCP), `EUROPE:DE01` (app) — and may omit the sales org (`EUROPE` → `EUROPE::*`).
 * routing-rules has exactly one document, key `*`, whatever the caller sent.
 */
function normalizeKey(kind, key) {
  if (kind === 'routing-rules') return WILDCARD;
  if (key === undefined || key === null || key === '') return null;
  const raw = String(key);
  if (!COMPOSITE_KINDS.has(kind)) return raw;
  const [head, tail] = raw.includes('::') ? raw.split('::') : raw.includes('/') ? raw.split('/') : raw.includes(':') ? raw.split(':') : [raw];
  return `${head}::${tail && tail !== '' ? tail : WILDCARD}`;
}

function requireKind(req, kind) {
  if (!kind) return req.reject(400, `kind is required — one of ${Object.keys(KINDS).join(', ')}.`);
  if (!isKind(kind)) return req.reject(400, `Unknown document kind "${kind}" — one of ${Object.keys(KINDS).join(', ')}.`);
  return kind;
}

module.exports = { normalizeKey, requireKind, COMPOSITE_KINDS };
