# approuter

SAP approuter in front of the pricing backend and the SAPUI5 UI:

- `^/rest/*` → the `srv-api` destination (CAP backend), XSUAA token forwarded.
- `^/app-c4c/*` → static `resources/` (the staged copy of `app-c4c/webapp` — run
  `npm run stage` here, or let the MTA build do it).
- Welcome file is the UI, so the approuter URL *is* the app URL.

## C4C iframe support (set as env in mta.yaml / manifest)

- `COOKIES={"SameSite":"None"}` — session cookie `SameSite=None; Secure`, required inside a
  cross-site iframe.
- `SEND_XFRAMEOPTIONS=false` + `httpHeaders` with
  `Content-Security-Policy: frame-ancestors 'self' https://*.crm.ondemand.com` — only C4C
  (and the approuter's own origin) may frame the app.

`csrfProtection` is off on the REST route for now — the UI does not fetch/replay
x-csrf-tokens yet; harden when the app goes beyond pilot use.

Not exercised against a real CF org from the sandbox (no cf CLI/credentials here) — same
status as the rest of the deployment artifacts, see `docs/DEPLOYMENT.md`.
