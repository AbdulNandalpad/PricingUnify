# api6-client

The single door to API6 (requirements §8). One call per pricing run; API6 delivers raw
facts only — routing, cost candidates with provenance, elements (freight/duty/tariff
amounts, MOLV/MOV/SPU), FX — never a pre-applied markup. Output is shaped exactly like
engine-core's `facts` argument.

## Modes

- **`recorded`** (default) — replays a JSON fixture from `recorded/<scenario>.json`. No
  network, no credentials. This is what everything in this repo runs on today.
- **`live`** — makes a real authenticated HTTP call. Needs `API6_MODE=live`,
  `API6_BASE_URL`, and an auth strategy. Not wired to a real API6 endpoint yet — the API
  key/credentials for that are for later.

## Auth strategies (`src/auth/strategies.js`)

Pluggable outbound auth, reusable by any future connector, not just API6:

| Strategy | Use case |
|---|---|
| `noAuth()` | Recorded/dev mode, or a genuinely open endpoint. |
| `apiKeyAuth({ headerName, apiKey })` | A static API key header. |
| `basicAuth({ username, password })` | HTTP Basic. |
| `oauth2ClientCredentialsAuth({ tokenUrl, clientId, clientSecret, scope })` | Fetches and caches a bearer token, refreshes on expiry. |
| `btpDestinationAuth({ destinationName, resolveDestination })` | Mirrors a real BTP Destination: resolves credentials at call time (never stored in our own config) and delegates to whichever of the strategies above the resolved destination declares. `resolveDestination` is injected so local dev/tests never need a real BTP environment. |

```js
const { createApi6Client, apiKeyAuth } = require('@tss-pricing/api6-client');

// dev (default): no credentials needed
const client = createApi6Client();
const facts = await client.getPricingFacts({ region: 'EUROPE', salesOrg: '*', items });

// later, pointed at the real thing:
const liveClient = createApi6Client({
  mode: 'live',
  baseUrl: process.env.API6_BASE_URL,
  auth: apiKeyAuth({ apiKey: process.env.API6_API_KEY }),
});
```

## Recorded payloads

`recorded/<region>-<scenario>.json`, e.g. `europe-default.json`. Add real (anonymized)
API6 responses here as they become available — same fixtures double as golden-test input.
