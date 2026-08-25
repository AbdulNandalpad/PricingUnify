# srv — CAP Node.js backend

CAP is only the host — all pricing logic lives in `@tss-pricing/engine-core`, all config
logic in `@tss-pricing/config-model`, all outbound facts come through
`@tss-pricing/api6-client`. This folder wires them together and adds auth.

## Run it

```bash
npm install            # from repo root
node srv/server.js     # or: npm run start:srv
```

Boots on `http://localhost:4004` with a seeded EUROPE (`salesOrg: '*'`) demo config and
API6 in recorded-payload mode — no external credentials needed. The CAP project root is
the repo root (where `package.json`'s `cds` config lives, and where `srv/*.cds` is found
by CAP's own `srv/` convention) — `server.js` forces `process.cwd()` there on boot so it
behaves the same whether you run it from the repo root or from inside `srv/`.

## Services

| Service | Path | Actions |
|---|---|---|
| `PricingService` | `/rest/pricing` | `price(payload)` — resolves the effective (region, salesOrg) config, resolves facts via API6, calls `engine-core.price()`, returns the full result + trace. |
| `ConfigService` | `/rest/config` | `getEffectiveConfig`, `listVersions`, `listSuggestions` (read); `suggestChange`, `approveSuggestion`, `rejectSuggestion` (admin) — thin wrappers over config-model's `ConfigStore` and AI pipeline. |

CAP's REST protocol maps a POST body's top-level `payload` field to the action's `payload:
Map` parameter (an arbitrary JSON object) — see `pricing-service.cds` / `config-service.cds`.
`function`s (the read endpoints) take plain query-string params instead.

```bash
curl -u alice:x -X POST http://localhost:4004/rest/pricing/price \
  -H 'Content-Type: application/json' \
  -d '{"payload":{"region":"EUROPE","salesOrg":"*","items":[{"partNumber":"P-10023","quantity":10}]}}'
```

## Auth

**Inbound** (who's allowed to call this API): CAP's built-in profile-based auth —
`kind: "mocked"` locally with two demo users (`package.json`'s `cds.requires.auth.users`),
`kind: "xsuaa"` under the `[production]` profile once a real XSUAA service binding exists
(descriptor: `xs-security.json`, inert locally).

| User | Password | Roles |
|---|---|---|
| `alice` | any | `PricingViewer` |
| `bob` | any | `PricingAdmin`, `PricingViewer` |

`@requires: 'authenticated-user'` gates the read endpoints; `@requires: 'PricingAdmin'`
gates anything that can change a live config (request/approve/reject an AI suggestion) —
narrower than config-model's own "any `approvedBy` string is accepted" gap (still tracked
in CLAUDE.md as a parked governance item), but now at least an authenticated admin, not
literally anyone who can reach the API.

**Outbound** (how this backend calls API6): see `api6-client/README.md` — pluggable
NoAuth/ApiKey/Basic/OAuth2-client-credentials/BTP-destination strategies. `srv/lib/api6.js`
defaults to recorded-payload mode; pointing it at a real API6 endpoint is a config change,
not a code change.

## The AI-suggestion endpoint today

`ConfigService.suggestChange` requires `ANTHROPIC_API_KEY` to actually call an AI. Without
it, the endpoint responds `{ status: "AI_NOT_CONFIGURED" }` rather than faking a
suggestion — that's deliberate: only tests (config-model's own, via `createFakeClient()`)
should ever see a canned AI response. Set the key when it's time to wire this up for real;
no code change needed.

## Tests

`node --test` (`srv/test/api.test.js`) spawns the real server on a test port and exercises
it over HTTP — auth (401/403), the happy pricing path against the seeded config, a
missing-config 422, and the admin-gated config endpoints. No CDS entities/DB yet: config
persistence is `config-model`'s in-memory `ConfigStore`, seeded fresh on every boot
(`srv/lib/seed.js`) — real HANA/Postgres persistence is a later step.
