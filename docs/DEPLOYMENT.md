# Deploying PricingUnify to Cloud Foundry

**I have no `cf` CLI, no BTP credentials, and no VCAP env vars in this sandbox** — I can't
run any of this myself. Everything below is prepared for you to run, based on how CAP +
XSUAA + HANA Cloud on BTP CF normally work; it has never been exercised against a real
subaccount (CF first push is still parked, `CLAUDE.md`). If a step errors, paste me the
output and we'll fix it together.

Scope: get `srv/` (the CAP backend) reachable on CF with real XSUAA auth and a real
database, so the React app (`app/`), the MCP server and future C4C / Build Apps
integrations can call it **on behalf of a named user**. The React app is the product UI
again (v2, `ARCHITECTURE_V2.md` §6); serving it from CF needs an approuter that is not
set up yet — see "Not yet done".

## Why we push the whole repo root, not `srv/` alone

`srv/` depends on `@tss-pricing/engine-core`, `@tss-pricing/config-model`, and
`@tss-pricing/api6-client` via npm workspaces (symlinks resolved from the repo root's
`node_modules`). If you `cf push` from inside `srv/`, the buildpack's `npm install` won't
see the workspace and those packages won't resolve. `manifest.yml` instead pushes `path: .`
(the repo root) with `command: node srv/server.js` — the buildpack's `npm install` at the
root resolves workspaces correctly, and `.cfignore` strips out local `node_modules/`,
`.git/`, and other things the buildpack doesn't need uploaded.

`srv/server.js` `chdir`s to the repo root on boot, so this also matches how it runs
locally — the CAP project root is always the repo root, never `srv/` itself.

## Persistence

| Profile | Database | How |
|---|---|---|
| local (default) | SQLite file `db.sqlite` at the repo root (gitignored) | `@cap-js/sqlite`; `cds deploy` runs on first boot; seeds load only when `ConfigDocuments` is empty |
| `CDS_ENV=test` | SQLite in memory | what `srv/test` uses |
| `[production]` on BTP, **today** | Same SQLite file, on CF's local (ephemeral) disk | Deliberate placeholder (2026-09-10) so `cf push` boots and is reachable before a real database decision/cost is committed to — **data does not survive a restage/restart**. Do not treat anything written under this state as durable. |
| `[production]` on BTP, **once decided** | **HANA Cloud** (`@cap-js/hana`, HDI container) **or Postgres** (`@cap-js/postgres`) | Either: `cf create-service hana hdi-shared ...` or a Postgres service, add `@cap-js/hana`/`@cap-js/postgres` to `srv/package.json`, add `"[production]": { "kind": "hana" }` (or `postgres`) back to root `package.json`'s `cds.requires.db`, bind the service in `manifest.yml`. No HANA-specific SQL exists anywhere, by rule, so either works with the same CDS model. |

Two tables carry everything (`ARCHITECTURE_V2.md` §4.1): `ConfigDocuments` (every
version of every rules document, DRAFT/ACTIVE/SUPERSEDED) and `PricingDocuments` (one row
per `price` call: who, what, result, trace, config versions). Volume is small; there is
no query layer beyond CAP's.

HANA specifics to do once — **verify on first deploy**:

```bash
cf create-service hana hdi-shared tss-pricing-db
```

then add `tss-pricing-db` to `manifest.yml`'s `services:` (today it lists only the XSUAA
instance) and make sure `@cap-js/hana` is a dependency of `srv/` (locally only
`@cap-js/sqlite` is installed). Schema deployment to the HDI container is a separate
step (`cds deploy --to hana` or an MTA `db` module) — CAP does not auto-deploy on boot in
production the way it does with SQLite. Which of the two you use decides whether we add
an `mta.yaml`; not decided yet.

## Steps

**1. Prereqs**
- `cf` CLI installed and you're logged in: `cf login` (or `cf login --sso`), right
  org/space targeted (`cf target -o <org> -s <space>`).
- Subaccount entitled to **XSUAA** and **SAP HANA Cloud / HANA Schemas & HDI Containers**.

**2. Create the XSUAA service instance** (from `srv/xs-security.json`, already in the repo):
```bash
cf create-service xsuaa application tss-pricing-xsuaa -c srv/xs-security.json
```

**3. Create the database** — see "Persistence" above.

**4. Push**
```bash
cf push
```
Uses `manifest.yml` at the repo root — Node.js buildpack, `node srv/server.js`, bound to
`tss-pricing-xsuaa` (and, after step 3, `tss-pricing-db`), `NODE_ENV=production` (which
flips `cds.requires.auth` to `kind: xsuaa` per the `[production]` override in the root
`package.json`).

**5. Verify it's up**
```bash
cf apps                                   # note the deployed route
curl https://<your-route>/health          # -> {"status":"UP"}
curl -i https://<your-route>/rest/pricing/whoami   # -> 401: no user, as intended
```
The mocked `alice`/`bob` users only exist in local dev.

**6. Give people roles**

BTP cockpit → Security → Role Collections: create collections from the `PricingViewer`
and `PricingAdmin` role templates in `xs-security.json` and assign them to users of your
identity provider. Every human caller — browser, Build Apps, MCP — needs one.

## On behalf of user — how callers authenticate

**Everything business-facing runs as a named user; `srv` rejects technical
(client-credentials) tokens with `403 NO_USER_PRINCIPAL`.** The full rule, the reasons,
and the token flow for each caller (approuter session, XSUAA JWT-bearer exchange for
Build Apps and other BTP apps, SAML-bearer principal propagation from C4C, a personal user
token for the MCP host, the local mocked equivalent) are in
**[`ON_BEHALF_OF_USER.md`](ON_BEHALF_OF_USER.md)**. Read it before configuring any
Destination — the earlier version of this runbook recommended `OAuth2ClientCredentials`
for Build Apps; that no longer works and was never right.

A user token to test with, today: log in through an approuter (not yet deployed), or use
the JWT-bearer exchange from another app's user token — both described there.

## MCP server

`mcp-server/` (`mcp-server/README.md`) is not a CF app: it runs on the user's own machine
inside Claude Desktop / Claude Code and talks to the deployed `srv` over HTTPS with that
user's token:

```json
"pricingunify": {
  "command": "node",
  "args": ["<repo>/mcp-server/src/index.js"],
  "env": { "PRICING_API_BASE": "https://<your-route>", "PRICING_USER_TOKEN": "<user JWT>" }
}
```

It refuses to start without a user credential and forwards it on every call. No tool
publishes configuration. Production CORS does not affect it (server-to-server).

## Not yet done / known limitations

- **No approuter.** The React app is the UI, but nothing serves it on CF yet and there
  is no XSUAA login page. Until an `approuter/` module exists, `app/` runs locally
  against the deployed backend only if CORS is opened (see next point) and a user token
  is supplied another way.
- **CORS is off in production** (`[production]: { cors: false }` in the root
  `package.json`). Correct once an approuter makes UI and API same-origin; loosen it only
  as a stop-gap.
- **`manifest.yml` binds only XSUAA** today — add the HANA instance (above).
- **API6 and the AI pipeline are still in recorded/unconfigured mode** — `API6_MODE`,
  `API6_BASE_URL`, and `ANTHROPIC_API_KEY` are `cf set-env` variables you can add whenever
  those credentials are ready; no code changes needed. Without `ANTHROPIC_API_KEY`,
  `suggestChange` reports `AI_NOT_CONFIGURED` rather than faking a suggestion.
- **Golden data** is finance-verifiable in shape but not yet signed off as production
  rates — do not treat a deployed price as a released price until it is.
