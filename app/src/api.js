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
  const url = method === 'GET' ? `${API_BASE}${path}?${new URLSearchParams(payload).toString()}` : `${API_BASE}${path}`;
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

export function getEffectiveConfig({ user, region, salesOrg }) {
  return callAction('/rest/config/getEffectiveConfig', { user, method: 'GET', payload: { region, salesOrg } });
}

export { ApiError };
