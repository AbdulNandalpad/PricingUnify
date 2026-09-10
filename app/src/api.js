/**
 * The app's only door to the backend — one function per endpoint of the REST contract in
 * docs/ARCHITECTURE_V2.md §4.3 (CAP `@protocol: 'rest'`: GET functions take query params,
 * POST actions take `{ payload }`). Every request carries the signed-in demo user's Basic
 * auth header; in production the approuter session replaces it with no code change here.
 *
 * Nothing in this file prices anything. Numbers come back as decimal strings.
 *
 * `VITE_API_MODE=mock` swaps the transport for `mockApi.js` — a dev/demo aid returning the
 * same contract shapes from the prototype's sample data. It must never ship as default.
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
export const API_MODE = import.meta.env.VITE_API_MODE === 'mock' ? 'mock' : 'live';
const mock = API_MODE === 'mock' ? import('./mockApi.js') : null;

export const DEMO_USERS = {
  alice: { label: 'alice — viewer', password: 'x' },
  bob: { label: 'bob — pricing admin', password: 'x' },
};

let currentUser = 'bob';
export function setCurrentUser(user) {
  if (DEMO_USERS[user]) currentUser = user;
}
export function getCurrentUser() {
  return currentUser;
}

function authHeader() {
  const { password } = DEMO_USERS[currentUser];
  return `Basic ${btoa(`${currentUser}:${password}`)}`;
}

export class ApiError extends Error {
  constructor(status, body) {
    const msg = typeof body === 'string' ? body : body?.error?.message || body?.message || `Request failed (${status})`;
    super(msg);
    this.status = status;
    this.body = body;
    this.code = (typeof body === 'object' && (body?.error?.code || body?.code)) || null;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
}

/** Human sentence for any failure — a 403 must read as a permission problem, never a blank. */
export function describeError(err) {
  if (err instanceof ApiError) {
    if (err.status === 403) return `Not allowed (403): ${err.message}. This action needs the PricingAdmin role.`;
    if (err.status === 401) return 'Not signed in (401) — pick a user in the top bar.';
    if (err.status === 404) return `Not found (404): ${err.message}`;
    if (err.status === 422) return `Rejected by validation (422): ${err.message}`;
    return `${err.status}: ${err.message}`;
  }
  if (err instanceof TypeError && /fetch/i.test(err.message)) return 'The pricing backend is not reachable (is srv running on :4004?).';
  return err?.message || String(err);
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

async function callAction(path, { payload, method = 'POST' } = {}) {
  if (mock) {
    const m = await mock;
    return m.handle(path, method, method === 'GET' ? compact(payload) : payload, currentUser);
  }
  // NOT URLSearchParams: it encodes spaces as "+", which the CDS REST query parser does not
  // decode back to a space (only %20 — verified against srv) — a formula or any free-text
  // value with a space would silently arrive corrupted server-side.
  const toQuery = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const url = method === 'GET' ? `${API_BASE}${path}?${toQuery(compact(payload))}` : `${API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
    body: method === 'GET' ? undefined : JSON.stringify({ payload }),
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}
const get = (path, payload) => callAction(path, { method: 'GET', payload });
const post = (path, payload) => callAction(path, { method: 'POST', payload });

/** CAP returns collections either bare or wrapped (`{ value }` / a named key). */
export function asList(res, key) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res[key])) return res[key];
  if (res && Array.isArray(res.value)) return res.value;
  return [];
}

/** Document keys for `getEffective(kind, key, …)` — the same `docKey` config-model, srv and
 *  the ConfigDocuments table agree on (`config-model/src/kinds.js`): composite keys join with
 *  `::` — `EUROPE::*` for a region-wide region-config, `SAP::*` for a region-route. */
export const KEY_SEP = '::';
export function docKey(kind, parts) {
  if (kind === 'region-config') return `${parts.region}${KEY_SEP}${parts.salesOrg || '*'}`;
  if (kind === 'region-route') return `${parts.ood}${KEY_SEP}${parts.salesOrg || '*'}`;
  if (kind === 'routing-rules') return '*';
  return parts.key ?? parts.id ?? parts.supplier ?? parts.customerId;
}

/** The kinds the Pricing rules screen edits as drafts, with their human names. */
export const RULE_KINDS = {
  'region-config': 'Region · cost plus',
  'price-list': 'Price list',
  'catalog-book': 'Catalog + formula',
  'routing-rules': 'Which type applies',
};

/* ── PricingService ─────────────────────────────────────────────────────── */
export const whoami = () => get('/rest/pricing/whoami');
/** payload: { customerId, region?, salesOrg?, priceDate, items[] } — items carry partNumber,
 *  quantity and any of pricingType, book, supplier, warehouse, stockClass, additionalCost,
 *  ood, mroqOverride, marginOverride, components[]. */
export const price = (payload) => post('/rest/pricing/price', payload);
export const fetchItemAttributes = (payload) => post('/rest/pricing/fetchItemAttributes', payload);
export const getPricingDocument = (id) => get('/rest/pricing/getPricingDocument', { id });
export const listPricingDocuments = (q) => get('/rest/pricing/listPricingDocuments', q);
/** payload: { customerId, region, priceDate, items?, documentIds?, draft: {kind,key,version}, drafts? } */
export const simulate = (payload) => post('/rest/pricing/simulate', payload);

/* ── ConfigService — reads ──────────────────────────────────────────────── */
export const getEffective = (kind, key, asOf) => get('/rest/config/getEffective', { kind, key, asOf });
export const listVersions = (kind, key) => get('/rest/config/listVersions', { kind, key });
export const getVersion = (kind, key, version) => get('/rest/config/getVersion', { kind, key, version });
export const diff = (kind, key, a, b) => get('/rest/config/diff', { kind, key, a, b });
export const listBooks = (kind) => get('/rest/config/listBooks', { kind });
export const listSuppliers = (asOf) => get('/rest/config/listSuppliers', { asOf });

/** Open drafts for a document. Contract-wise a DRAFT is just a version with
 *  `status: 'DRAFT'`, so this reads `listVersions` and filters — no extra endpoint needed. */
export async function listDrafts(kind, key) {
  const res = await listVersions(kind, key);
  return asList(res, 'versions').filter((v) => v.status === 'DRAFT');
}

/* ── ConfigService — writes (PricingAdmin) ──────────────────────────────── */
export const saveDraft = (kind, doc) => post('/rest/config/saveDraft', { kind, doc });
export const publish = ({ kind, key, version, effectiveFrom, note }) => post('/rest/config/publish', { kind, key, version, effectiveFrom, note });
export const discardDraft = ({ kind, key, version }) => post('/rest/config/discardDraft', { kind, key, version });
export const saveActive = (payload) => post('/rest/config/saveActive', payload);

/* ── ConfigService — AI suggestions ─────────────────────────────────────── */
export const suggestChange = ({ instruction, targetKind, targetKey, version }) => post('/rest/config/suggestChange', { targetKind, targetKey, version, instruction });
export const approveSuggestion = ({ suggestionId }) => post('/rest/config/approveSuggestion', { suggestionId });
export const rejectSuggestion = ({ suggestionId, reviewNotes }) => post('/rest/config/rejectSuggestion', { suggestionId, reviewNotes });
export const listSuggestions = (status) => get('/rest/config/listSuggestions', { status });

/** `GET validateFormula(formula, kind, key)` → `{ valid, message, variables? }`. Resolves to
 *  null when the backend has no such route, so the catalog sheet falls back to its syntax
 *  hint and the server's 422 on save. */
let formulaEndpointMissing = false;
export async function validateFormula(formula, kind = 'catalog-book', key) {
  if (formulaEndpointMissing) return null;
  try {
    return await get('/rest/config/validateFormula', { formula, kind, key });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      formulaEndpointMissing = true;
      return null;
    }
    throw err;
  }
}
