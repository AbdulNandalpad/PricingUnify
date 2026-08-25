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
