/**
 * Outbound auth strategies for connectors (API6 today; any future connector reuses this).
 * Each strategy is `{ type, async getHeaders() }` — a connector merges those headers into
 * its request and never needs to know which auth type it's dealing with.
 *
 * This is the "different auth types" the locked architecture implies by naming BTP
 * "destinations to API6": a BTP Destination itself resolves to one of NoAuthentication /
 * BasicAuthentication / OAuth2ClientCredentials / an API key header — see btpDestinationAuth,
 * which is a meta-strategy that delegates to whichever of the others the resolved
 * destination declares.
 */

function noAuth() {
  return {
    type: 'NONE',
    async getHeaders() {
      return {};
    },
  };
}

function apiKeyAuth({ headerName = 'apikey', apiKey }) {
  if (!apiKey) throw new Error('apiKeyAuth requires an apiKey.');
  return {
    type: 'API_KEY',
    async getHeaders() {
      return { [headerName]: apiKey };
    },
  };
}

function basicAuth({ username, password }) {
  if (!username || !password) throw new Error('basicAuth requires username and password.');
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return {
    type: 'BASIC',
    async getHeaders() {
      return { Authorization: `Basic ${token}` };
    },
  };
}

/** Caches the bearer token and only re-requests it once it's within clockSkewSeconds of
 *  expiring — a connector can call getHeaders() on every request without hammering the
 *  token endpoint. `fetchImpl` is injectable so tests never need a real token endpoint. */
function oauth2ClientCredentialsAuth({ tokenUrl, clientId, clientSecret, scope, fetchImpl = fetch, clockSkewSeconds = 30 }) {
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error('oauth2ClientCredentialsAuth requires tokenUrl, clientId, and clientSecret.');
  }
  let cached = null;

  async function fetchToken() {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    if (scope) body.set('scope', scope);
    const res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`OAuth2 client-credentials token request failed: ${res.status} ${res.statusText}`);
    const json = await res.json();
    cached = { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - clockSkewSeconds * 1000 };
  }

  return {
    type: 'OAUTH2_CLIENT_CREDENTIALS',
    async getHeaders() {
      if (!cached || Date.now() >= cached.expiresAt) await fetchToken();
      return { Authorization: `Bearer ${cached.accessToken}` };
    },
  };
}

const DELEGATE_BY_DESTINATION_AUTH_TYPE = {
  NoAuthentication: (d) => noAuth(),
  BasicAuthentication: (d) => basicAuth({ username: d.User, password: d.Password }),
  OAuth2ClientCredentials: (d) =>
    oauth2ClientCredentialsAuth({ tokenUrl: d.tokenServiceURL, clientId: d.clientId, clientSecret: d.clientSecret, scope: d.scope }),
  APIKeyAuthentication: (d) => apiKeyAuth({ headerName: d.headerName || 'apikey', apiKey: d.apiKey }),
};

/**
 * Mirrors a BTP Destination: production resolves `destinationName` via the Destination
 * service (VCAP_SERVICES + an XSUAA token) at call time, so credentials are never stored
 * in our own config — only the destination *name* is. `resolveDestination` is injected so
 * local dev/tests never need a real BTP environment; it must return `{ Authentication,
 * ...type-specific fields }` in the shape the Destination service itself returns.
 */
function btpDestinationAuth({ destinationName, resolveDestination }) {
  if (!destinationName) throw new Error('btpDestinationAuth requires a destinationName.');
  if (typeof resolveDestination !== 'function') throw new Error('btpDestinationAuth requires a resolveDestination(name) function.');
  let resolved = null;

  async function resolve() {
    const destination = await resolveDestination(destinationName);
    const build = DELEGATE_BY_DESTINATION_AUTH_TYPE[destination.Authentication];
    if (!build) throw new Error(`Unsupported destination Authentication type "${destination.Authentication}".`);
    resolved = { destination, strategy: build(destination) };
  }

  return {
    type: 'BTP_DESTINATION',
    async getHeaders() {
      if (!resolved) await resolve();
      return resolved.strategy.getHeaders();
    },
    async describe() {
      if (!resolved) await resolve();
      return { destinationName, delegatesTo: resolved.strategy.type };
    },
  };
}

module.exports = { noAuth, apiKeyAuth, basicAuth, oauth2ClientCredentialsAuth, btpDestinationAuth };
