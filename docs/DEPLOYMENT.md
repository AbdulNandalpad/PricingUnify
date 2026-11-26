# Deploying srv/ to Cloud Foundry

**I have no `cf` CLI, no BTP credentials, and no VCAP env vars in this sandbox** — I can't
run any of this myself. Everything below is prepared for you to run, based on how CAP +
XSUAA on BTP CF normally works; it hasn't been exercised against a real subaccount. If a
step errors, paste me the output and we'll fix it together.

Scope of this pass: get `srv/` (the CAP backend) reachable on CF with real XSUAA auth, so
SAP Build Apps (or anything else) can call it. `app/` (the React dev console) stays local
for now — the "screens" work is happening in Build Apps, a separate app model that doesn't
touch this repo.

## Why we push the whole repo root, not `srv/` alone

`srv/` depends on `@tss-pricing/engine-core`, `@tss-pricing/config-model`, and
`@tss-pricing/api6-client` via npm workspaces (symlinks resolved from the repo root's
`node_modules`). If you `cf push` from inside `srv/`, the buildpack's `npm install` won't
see the workspace and those packages won't resolve. `manifest.yml` instead pushes `path: .`
(the repo root) with `command: node srv/server.js` — the buildpack's `npm install` at the
root resolves workspaces correctly, and `.cfignore` strips out local `node_modules/`,
`.git/`, and other things the buildpack doesn't need uploaded.

`srv/server.js` already `chdir`s to the repo root on boot (a fix from an earlier local-dev
issue), so this also matches how it runs locally — the CAP project root is always the repo
root, never `srv/` itself.

## Steps

**1. Prereqs**
- `cf` CLI installed and you're logged in: `cf login` (or `cf login --sso` if your org
  requires it), with the right org/space targeted (`cf target -o <org> -s <space>`).
- Your subaccount is entitled to the **XSUAA** service (Security → Trust and entitlements
  in BTP cockpit, if `cf create-service` below fails with "service not found").

**2. Create the XSUAA service instance** (from `srv/xs-security.json`, already in the repo):
```bash
cf create-service xsuaa application tss-pricing-xsuaa -c srv/xs-security.json
```

**3. Push**
```bash
cf push
```
This uses `manifest.yml` at the repo root — Node.js buildpack, `node srv/server.js`,
bound to the `tss-pricing-xsuaa` service, `NODE_ENV=production` (which flips
`cds.requires.auth` to `kind: xsuaa` per the `[production]` override in the root
`package.json`).

**4. Verify it's up**
```bash
cf apps                                   # note the deployed route
curl https://<your-route>/health          # -> {"status":"UP"}
```
Hitting `/rest/pricing/price` will now correctly 401/403 without a real XSUAA-issued JWT —
the mocked `alice`/`bob` users only exist in local dev.

**5. Get a token to test with**

Two different shapes, pick based on who's calling:

- **A real human user** (e.g. testing from a browser / Postman with SSO): needs a role
  collection assigned in BTP cockpit (Security → Role Collections) built from the
  `PricingViewer`/`PricingAdmin` role templates in `xs-security.json`, mapped to your
  identity provider's users. This is the path for anything driven by a logged-in person.
- **A technical/service client** (e.g. SAP Build Apps calling server-side, not as a
  specific user): `cf create-service-key tss-pricing-xsuaa tss-pricing-key`, then
  `cf service-key tss-pricing-xsuaa tss-pricing-key` for `clientid`/`clientsecret`/
  `url`, and do an OAuth2 client-credentials token request against
  `<xsuaa-url>/oauth/token`. **Note:** a plain client-credentials token has no user, so
  it won't automatically satisfy `@requires: 'PricingAdmin'` unless the XSUAA client is
  explicitly granted that authority — if you hit 403s here, this is the thing to check
  first (BTP cockpit → your XSUAA instance → clients).

**6. Connect SAP Build Apps**

In BTP cockpit, the clean way is a **Destination** pointing at the CF route from step 4,
auth type `OAuth2ClientCredentials` against the `tss-pricing-xsuaa` service (same shape as
`api6-client`'s `btpDestinationAuth` — just in the other direction: Build Apps calling in,
instead of us calling out to API6). Build Apps then consumes that Destination as its data
source. This part happens in BTP cockpit / Build Apps itself — outside anything I can do
from here.

## Known limitations, still true after this deploy

- **No persistent DB.** `config-model`'s `ConfigStore` is in-memory — the seeded EUROPE
  demo config (and anything else) is gone on every restage/restart. Don't rely on approved
  AI suggestions surviving a redeploy yet; real persistence (HANA/Postgres) is still parked.
- **CORS is off in production** (`[production]: { cors: false }` in the root
  `package.json`). Fine if Build Apps calls server-side; if you see CORS errors from a
  browser-based caller, that config is where to loosen it (or, better long-term: front
  this with an approuter so the UI and API are same-origin — not set up yet).
- **API6 and the AI pipeline are still in recorded/unconfigured mode** — `API6_MODE`,
  `API6_BASE_URL`, and `ANTHROPIC_API_KEY` are all `cf set-env` variables you can add
  whenever those credentials are ready; no code changes needed either way.

---

## MTA deployment (approuter + UI) — added 2026-11-24

The repo now also carries an MTA descriptor (`mta.yaml`) covering three modules: the CAP
backend (`tss-pricing-srv`), the SAPUI5 UI (`tss-pricing-app-c4c`, staged into the
approuter at build time — no html5-apps-repo service needed), and the approuter
(`tss-pricing-approuter`: XSUAA login, serves the UI at `/app-c4c`, proxies `/rest/*` to
srv with the token forwarded).

```bash
npm install -g mbt            # SAP's MTA build tool
mbt build                     # produces mta_archives/tss-pricing-engine_1.0.0.mtar
cf deploy mta_archives/tss-pricing-engine_1.0.0.mtar
```

The approuter URL is the app URL (its welcome file is the UI). C4C embeds it as an iframe
mashup; the approuter is configured for that: session cookie `SameSite=None; Secure`
(`COOKIES` env), and `Content-Security-Policy: frame-ancestors 'self'
https://*.crm.ondemand.com` in place of the default X-Frame-Options.

The URL parameters C4C should pass into the iframe: `objectType=QUOTE|OPPORTUNITY`,
`objectId=<host object id>`, optional `mode=admin` (PricingAdmins only) and
`sap-theme=<ui5 theme>`.

Same caveat as everything else in this runbook: written ready-to-run but **not yet
exercised against a real BTP org** from the dev sandbox (no `cf`/`mbt` here). The plain
`cf push` path via `manifest.yml` still works for the backend alone.


---

## QUA -> PROD (one switch) — added 2026-11-26

Everything environment-specific hangs off **one setting, `TSS_ENVIRONMENT`** (default `QUA`; `PROD` for production).
It selects which API6 gateway, which C4C tenant and which credentials every outbound call uses; the Pricing screen shows
the environment as a badge (green QUA / red PROD) and the Admin → Connections tab says it too.

| What | QUA | PROD |
|---|---|---|
| API6 gateway URL | built in: `https://apimqua.tss.trelleborg.com` | **none built in** — set `API6_BASE_URL_PROD` (or the Connections tab) |
| C4C tenant URL | built in: `https://my352500.crm.ondemand.com` | **none built in** — set `C4C_URL_PROD` (or the Connections tab) |
| API6 credentials (Basic) | `API6_USERNAME_QUA` / `API6_PASSWORD_QUA` (or the unsuffixed `API6_USERNAME` / `API6_PASSWORD`) | `API6_USERNAME_PROD` / `API6_PASSWORD_PROD` **only** |
| C4C technical user | `C4C_USERNAME_QUA` / `C4C_PASSWORD_QUA` (or unsuffixed; user defaults to `Tss.integration`) | `C4C_USERNAME_PROD` / `C4C_PASSWORD_PROD` **only** |
| Mode | `API6_MODE` (`recorded` until you set `live`) — `API6_MODE_PROD` overrides it for PROD | |

Safety rules built in:
- **No cross-environment credentials.** The unsuffixed variables count for QUA only, so a PROD run can never pick up QUA
  credentials (nor send them to the PROD gateway). PROD URLs are never guessed: until they are set, Connections shows them as missing and a live call answers a typed failure naming the variable.
- **Connections-tab settings belong to the environment they were saved under** (server-stamped). After switching `TSS_ENVIRONMENT`, URLs saved under QUA are ignored and the tab says so until you save again.
- Credentials are never stored in config, only in the environment / BTP destination.

Switching to PROD = set the `*_PROD` variables (`cf set-env` or the MTA/deployment descriptor), set `TSS_ENVIRONMENT=PROD`,
set `API6_MODE_PROD=live`, restart. Nothing in code or pricing config changes: region rules, suppliers and margins are
the same configuration in both (note: config is still in-memory, so PROD needs the same rules re-entered or seeded until persistence exists).
Run `npm test` unchanged — tests scrub every `TSS_*`/`API6_*`/`C4C_*` variable and never reach a real system.
