/**
 * Backend-orchestrated pricing: calls the real CAP service (srv/) instead of running
 * engine-core in the browser. The backend resolves the effective config (config-model)
 * and the cost/element facts (api6-client, recorded mode) itself — this client only
 * sends the neutral pricing request and a Basic-auth demo user.
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export const DEMO_USERS = {
  alice: { label: 'alice — PricingViewer', password: 'x' },
  bob: { label: 'bob — PricingAdmin', password: 'x' },
};

function authHeader(user) {
  const { password } = DEMO_USERS[user];
  return `Basic ${btoa(`${user}:${password}`)}`;
}

class ApiError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.error?.message || body?.message || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function callAction(path, { user, payload, method = 'POST' }) {
  const definedParams = Object.fromEntries(Object.entries(payload || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const url = method === 'GET' ? `${API_BASE}${path}?${new URLSearchParams(definedParams).toString()}` : `${API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(user) },
    body: method === 'GET' ? undefined : JSON.stringify({ payload }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

export function priceViaBackend({ user, region, salesOrg, purpose, items }) {
  return callAction('/rest/pricing/price', { user, payload: { region, salesOrg, purpose, items } });
}

export function fetchItemAttributes({ user, region, salesOrg, items }) {
  return callAction('/rest/pricing/fetchItemAttributes', { user, payload: { region, salesOrg, items } });
}

export function getEffectiveConfig({ user, region, salesOrg, asOf }) {
  return callAction('/rest/config/getEffectiveConfig', { user, method: 'GET', payload: { region, salesOrg, asOf } });
}

export function listVersions({ user, region, salesOrg }) {
  return callAction('/rest/config/listVersions', { user, method: 'GET', payload: { region, salesOrg } });
}

export function getEffectiveSupplierConfig({ user, supplier, asOf }) {
  return callAction('/rest/config/getEffectiveSupplierConfig', { user, method: 'GET', payload: { supplier, asOf } });
}

export function listSuppliers({ user, asOf }) {
  return callAction('/rest/config/listSuppliers', { user, method: 'GET', payload: { asOf } });
}

export function listSupplierConfigVersions({ user, supplier }) {
  return callAction('/rest/config/listSupplierConfigVersions', { user, method: 'GET', payload: { supplier } });
}

export function getEffectiveRegionRoute({ user, ood, salesOrg, asOf }) {
  return callAction('/rest/config/getEffectiveRegionRoute', { user, method: 'GET', payload: { ood, salesOrg, asOf } });
}

export function listRegionRouteVersions({ user, ood, salesOrg }) {
  return callAction('/rest/config/listRegionRouteVersions', { user, method: 'GET', payload: { ood, salesOrg } });
}

export function getEffectivePartyConfig({ user, customerId, asOf }) {
  return callAction('/rest/config/getEffectivePartyConfig', { user, method: 'GET', payload: { customerId, asOf } });
}

export function listPartyConfigVersions({ user, customerId }) {
  return callAction('/rest/config/listPartyConfigVersions', { user, method: 'GET', payload: { customerId } });
}

export function saveRegionConfig({ user, payload }) {
  return callAction('/rest/config/saveRegionConfig', { user, payload });
}

export function saveSupplierConfig({ user, payload }) {
  return callAction('/rest/config/saveSupplierConfig', { user, payload });
}

export function saveRegionRoute({ user, payload }) {
  return callAction('/rest/config/saveRegionRoute', { user, payload });
}

export function savePartyConfig({ user, payload }) {
  return callAction('/rest/config/savePartyConfig', { user, payload });
}

export function listSuggestions({ user, region, status }) {
  return callAction('/rest/config/listSuggestions', { user, method: 'GET', payload: { region, status } });
}

export function suggestChange({ user, region, salesOrg, version, instruction }) {
  return callAction('/rest/config/suggestChange', { user, payload: { region, salesOrg, version, instruction } });
}

export function approveSuggestion({ user, suggestionId, newVersion }) {
  return callAction('/rest/config/approveSuggestion', { user, payload: { suggestionId, newVersion } });
}

export function rejectSuggestion({ user, suggestionId, reviewNotes }) {
  return callAction('/rest/config/rejectSuggestion', { user, payload: { suggestionId, reviewNotes } });
}

export { ApiError };
