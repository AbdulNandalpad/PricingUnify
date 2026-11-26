'use strict';

/**
 * HTTP client for the pricing REST API (srv/, /rest/pricing and /rest/config).
 *
 * The MCP server is deliberately a thin client of that API: no pricing logic, no config
 * access, no engine-core import. Whatever the caller is allowed to do is decided by the
 * backend's own role checks (PricingViewer / PricingAdmin) — this file only carries the
 * caller's credentials to it and turns failures into typed errors.
 *
 * Auth modes (first match wins):
 *   authorization   a ready-made Authorization header value (the HTTP transport passes the
 *                   MCP caller's own header straight through, so each caller is judged as
 *                   themselves)
 *   token           a bearer token (e.g. an XSUAA JWT)
 *   tokenUrl+clientId+clientSecret   OAuth2 client credentials; the token is cached until
 *                   shortly before it expires
 *   user+password   HTTP Basic — local development against the mocked CAP users only
 * Credentials are never written to logs or error messages.
 */

class PricingApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'PricingApiError';
    this.status = status;
    this.code = code || null;
  }
}

function createPricingClient({
  baseUrl,
  authorization,
  token,
  tokenUrl,
  clientId,
  clientSecret,
  user,
  password,
  timeoutMs = 30000,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) throw new Error('createPricingClient: baseUrl is required');
  const root = String(baseUrl).replace(/\/+$/, '');

  let cached = null; // { value, expiresAt } for client-credentials tokens

  async function clientCredentialsToken() {
    if (cached && cached.expiresAt > Date.now() + 30000) return cached.value;
    const res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new PricingApiError(res.status, `Could not obtain an access token (HTTP ${res.status}).`, 'TOKEN_REQUEST_FAILED');
    const body = await res.json();
    if (!body.access_token) throw new PricingApiError(502, 'Token endpoint answered without an access_token.', 'TOKEN_REQUEST_FAILED');
    cached = { value: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 300) * 1000 };
    return cached.value;
  }

  async function authHeader() {
    if (authorization) return authorization;
    if (token) return `Bearer ${token}`;
    if (tokenUrl && clientId && clientSecret) return `Bearer ${await clientCredentialsToken()}`;
    if (user && password) return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    return null;
  }

  async function request(method, path, body) {
    const headers = { Accept: 'application/json' };
    const auth = await authHeader();
    if (auth) headers.Authorization = auth;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new PricingApiError(504, `The pricing API did not answer within ${timeoutMs} ms.`, 'TIMEOUT');
      throw new PricingApiError(502, `The pricing API is not reachable at ${root} (${e && e.cause && e.cause.code ? e.cause.code : e.message}).`, 'UNREACHABLE');
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

    if (!res.ok) {
      const message = (json && json.error && json.error.message) || `HTTP ${res.status}`;
      const code = json && json.error && json.error.code;
      throw new PricingApiError(res.status, message, code);
    }
    return json;
  }

  return {
    baseUrl: root,
    hasCredentials: async () => (await authHeader()) !== null,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
  };
}

/** Build a client from process environment (stdio transport / the HTTP transport's fallback). */
function clientFromEnv(env = process.env, overrides = {}) {
  return createPricingClient({
    baseUrl: env.TSS_PRICING_BASE_URL || 'http://localhost:4004',
    token: env.TSS_PRICING_TOKEN,
    tokenUrl: env.TSS_PRICING_TOKEN_URL,
    clientId: env.TSS_PRICING_CLIENT_ID,
    clientSecret: env.TSS_PRICING_CLIENT_SECRET,
    user: env.TSS_PRICING_USER,
    password: env.TSS_PRICING_PASSWORD,
    timeoutMs: env.TSS_PRICING_TIMEOUT_MS ? Number(env.TSS_PRICING_TIMEOUT_MS) : undefined,
    ...overrides,
  });
}

module.exports = { createPricingClient, clientFromEnv, PricingApiError };
