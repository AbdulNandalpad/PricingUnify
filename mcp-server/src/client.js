'use strict';

/**
 * Thin HTTP client for srv's REST protocol (ARCHITECTURE_V2 §4.3): GET functions take
 * query params, POST actions take `{ payload }`. The client carries exactly one
 * credential — the calling user's — and forwards it verbatim on every request. There
 * is deliberately no way to construct one without a user credential (§4.2).
 */

const DEFAULT_BASE_URL = 'http://localhost:4004';

const NO_CREDENTIAL_MESSAGE = [
  'pricingunify-mcp: no user credential configured — refusing to start.',
  'This server acts on behalf of a real pricing user and has no identity of its own.',
  'Set ONE of:',
  '  PRICING_USER_TOKEN=<user JWT>            (production: sent as Authorization: Bearer)',
  '  PRICING_USER=<name> PRICING_PASSWORD=<pw> (local mocked auth, e.g. bob / x)',
  'See mcp-server/README.md and docs/ON_BEHALF_OF_USER.md.',
].join('\n');

class ApiError extends Error {
  constructor(status, body, fallbackText) {
    super(ApiError.describe(status, body, fallbackText));
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.code = body?.error?.code ?? null;
  }

  static describe(status, body, fallbackText) {
    const code = body?.error?.code;
    const message = body?.error?.message || body?.message || fallbackText || `Request failed (${status})`;
    if (status === 403 && (code === 'NO_USER_PRINCIPAL' || /NO_USER_PRINCIPAL/.test(String(message)))) {
      return 'The server refused the call because the credential carries no user principal (403 NO_USER_PRINCIPAL). '
        + 'PricingUnify runs on behalf of a real user only: supply a user token (PRICING_USER_TOKEN) or local user '
        + '(PRICING_USER/PRICING_PASSWORD), never a client-credentials token.';
    }
    if (status === 401) return `Not authenticated (401): ${message}. Check PRICING_USER_TOKEN or PRICING_USER/PRICING_PASSWORD.`;
    return `${status}${code && code !== String(status) ? ` ${code}` : ''}: ${message}`;
  }
}

function credentialFromEnv(env) {
  if (env.PRICING_USER_TOKEN) return `Bearer ${env.PRICING_USER_TOKEN}`;
  if (env.PRICING_USER && env.PRICING_PASSWORD) {
    return `Basic ${Buffer.from(`${env.PRICING_USER}:${env.PRICING_PASSWORD}`).toString('base64')}`;
  }
  const err = new Error(NO_CREDENTIAL_MESSAGE);
  err.code = 'NO_CREDENTIAL';
  throw err;
}

function definedParams(params) {
  return Object.fromEntries(
    Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
}

async function parseBody(res) {
  const text = await res.text();
  if (!text) return { body: null, text };
  try {
    return { body: JSON.parse(text), text };
  } catch {
    return { body: null, text };
  }
}

function createClient({ env = process.env, fetch: fetchImpl = globalThis.fetch, baseUrl } = {}) {
  const authorization = credentialFromEnv(env);
  const base = (baseUrl || env.PRICING_API_BASE || DEFAULT_BASE_URL).replace(/\/+$/, '');

  async function request(method, path, { params, payload } = {}) {
    // NOT URLSearchParams: it encodes spaces as "+", which the CDS REST query parser does not
    // decode back to a space (only %20 — verified against srv) — a formula or any free-text
    // value with a space would silently arrive corrupted server-side.
    const toQuery = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const query = method === 'GET' ? toQuery(definedParams(params)) : '';
    const url = `${base}${path}${query ? `?${query}` : ''}`;
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization },
        body: method === 'GET' ? undefined : JSON.stringify({ payload }),
      });
    } catch (cause) {
      const err = new Error(`Could not reach the pricing API at ${base} (${cause.message}). Is srv running?`);
      err.code = 'UNREACHABLE';
      throw err;
    }
    const { body, text } = await parseBody(res);
    if (!res.ok) throw new ApiError(res.status, body, text);
    return body;
  }

  return {
    baseUrl: base,
    authorization,
    get: (path, params) => request('GET', path, { params }),
    post: (path, payload) => request('POST', path, { payload }),
  };
}

module.exports = { createClient, credentialFromEnv, ApiError, DEFAULT_BASE_URL, NO_CREDENTIAL_MESSAGE };
