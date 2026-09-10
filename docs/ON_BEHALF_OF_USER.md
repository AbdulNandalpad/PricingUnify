# On behalf of user — the identity rule

**Status:** binding (owner decision 2026-09-10, `ARCHITECTURE_V2.md` §0 item 4 and §4.2).

> Every call into the pricing engine carries a real, named user. Nothing prices,
> proposes, drafts or publishes as an anonymous technical client — not the React app,
> not C4C, not SAP Build Apps, not the MCP server.

## 1. Why

- **Audit.** A price that reached a customer must answer "who asked for it, under which
  rules, when". `requestedBy` on every `PricingDocument` is only meaningful if it names a
  person. A shared technical user makes every quote look identical in the log.
- **Four eyes.** The config lifecycle is suggest → approve (creates a DRAFT) → publish.
  `authoredBy`, `reviewedBy` and `publishedBy` are three names that must be allowed to
  differ; with a technical user they cannot.
- **No shared technical users.** A client secret in a CPI artefact, a Build Apps
  destination or an MCP config is a credential everybody with access to that artefact
  effectively holds. Role collections assigned to people are revocable per person;
  a technical client's scopes are not.
- **AI safety.** Agents act through MCP. An agent that could act as "the pricing system"
  could publish rules. An agent that acts as bob can do only what bob may do, and bob's
  name is on it.

## 2. What `srv` enforces (`ARCHITECTURE_V2.md` §4.2)

These are the server-side rules the v2 backend implements. The MCP server and the app
rely on them; they do not re-implement them.

1. Every endpoint is `@requires: 'authenticated-user'` or a role. There are no endpoints
   for technical clients.
2. A `before('*')` handler on both `PricingService` and `ConfigService` rejects with
   **`403 NO_USER_PRINCIPAL`** any request whose `req.user` is anonymous, `privileged`,
   or a token without a user id — which is what an XSUAA `client_credentials` token is
   (no `user_name` claim).
3. Identity is taken from the token only: `requestedBy` on pricing documents,
   `provenance.authoredBy` / `publishedBy` on config writes, `reviewedBy` on suggestions
   = `req.user.id`. Identities supplied in a payload are ignored.
4. Roles: `PricingViewer` — price, explain, read rules, simulate. `PricingAdmin` — save
   drafts, publish, review AI suggestions. A distinct approver role is parked (topic 9).

Smoke test after any deploy (expected: 401, 403, 200):

```bash
curl -i $BASE/rest/pricing/whoami                                    # no credential   → 401
curl -i -H "Authorization: Bearer $CLIENT_CREDENTIALS_TOKEN" $BASE/rest/pricing/whoami   # → 403 NO_USER_PRINCIPAL
curl -i -H "Authorization: Bearer $USER_TOKEN" $BASE/rest/pricing/whoami                 # → 200 {"id":"…","roles":[…]}
```

## 3. How each caller obtains a *user* token on BTP

All flows end the same way: the caller holds a JWT issued by the subaccount's XSUAA
**for the pricing engine's `xsappname`** (`tss-pricing-engine`, `srv/xs-security.json`)
**with a `user_name`** and the scopes of the role collection assigned to that person.
`srv` (CAP + `@sap/xssec`) validates it against the bound XSUAA instance.

Prerequisite for every person: a role collection in the BTP cockpit built from the
`PricingViewer` / `PricingAdmin` role templates, assigned to their identity-provider user.
No role collection → a valid user token with no scopes → 403 on role-gated endpoints.

### 3.1 Browser users (React app)

Standard approuter flow: the approuter redirects to XSUAA (OAuth2 authorization code),
XSUAA authenticates against the configured IdP, the approuter keeps the session and
forwards the user JWT to `srv` on every request. Nothing to implement — configuration
only. *Not yet set up in this repo: there is no `approuter/` and CF has never been
pushed (see `DEPLOYMENT.md`); verify on first deploy.*

### 3.2 Another BTP application acting for its logged-in user — JWT bearer exchange

When a caller already holds a **user** JWT for *its own* xsappname (Build Apps, a CAP
extension, a Fiori app) and needs one for the pricing engine, it exchanges it:

```
POST <xsuaa-url>/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
&client_id=<pricing engine XSUAA clientid>
&client_secret=<pricing engine XSUAA clientsecret>
&assertion=<the caller's user JWT>
&response_type=token
```

The response is a user token for `tss-pricing-engine` carrying the same `user_name` and
that user's pricing scopes. Conditions SAP documents for this grant — **verify on first
deploy**: both applications live in the same subaccount (same XSUAA tenant) or a trust
between the subaccounts has been configured; the user exists in the pricing engine's
role collections; the exchanged token is not refreshable by the caller in the same way a
directly issued one is. The clientid/clientsecret here identify *which app is asking*;
they do not become the identity — the `assertion` does.

On BTP this is normally not hand-coded: a **Destination** with authentication type
`OAuth2UserTokenExchange` (or `OAuth2JWTBearer`) performs exactly this exchange when the
consuming runtime passes the current user's token through — verify the exact type name
offered by the Destination service UI on first deploy.

### 3.3 SAP Build Apps

Build Apps runs in the user's browser under the BTP launchpad / approuter session, so the
user JWT exists. Configure the pricing backend as a Destination with
`OAuth2UserTokenExchange` (§3.2) — **not** `OAuth2ClientCredentials`, which is what
`DEPLOYMENT.md` used to recommend and is now refused by `srv`. Verify on first deploy that
the Build Apps runtime forwards the user token for that destination type (SAP documents
"user token exchange" support for BTP destinations in Build Apps; the exact setting has
not been exercised here).

### 3.4 C4C (SAP Sales / Service Cloud) — principal propagation

C4C calls out via Cloud Integration (CPI) or directly through a BTP Destination. The user
is propagated with **`OAuth2SAMLBearerAssertion`**: the destination service obtains a SAML
assertion for the current C4C user from the trusted IdP and exchanges it at XSUAA with
`grant_type=urn:ietf:params:oauth:grant-type:saml2-bearer` for a user JWT of the pricing
engine. Requirements — **verify on first deploy**: trust between C4C's IdP and the
subaccount (same user identifier, typically e-mail), the destination configured with the
pricing engine's XSUAA `clientid`/`clientsecret`/token URL and the user's name id format,
and (for a CPI flow) the "principal propagation" authentication on the receiver adapter.
If C4C can only do a fixed technical user for the call, that is exactly the case this
rule forbids: the integration then needs CPI in between to perform the propagation.

### 3.5 MCP host (Claude Desktop / Claude Code, on a person's workstation)

There is no browser session and no BTP runtime. The person supplies **their own** user
JWT as `PRICING_USER_TOKEN`, and the MCP server forwards it unchanged. Ways to get one:

- An **approuter "token" page** — open the deployed app, log in through XSUAA, and copy
  the current access token from a small authenticated endpoint that echoes it. This is
  the recommended path; it is not built yet (no approuter in the repo).
- A local **authorization-code helper** that opens the browser to
  `<xsuaa-url>/oauth/authorize?client_id=…&response_type=code&redirect_uri=http://localhost:<port>/cb`
  and swaps the code for a token. Requires that redirect URI to be whitelisted in
  `xs-security.json` (`oauth2-configuration.redirect-uris`) — not present today; verify.
- **`grant_type=password`** against XSUAA works only for the default SAP ID service or
  IdPs that allow it; SAP discourages it. Not recommended.

Tokens expire (XSUAA default access-token validity is 12 h; `xs-security.json` can set
`token-validity` — verify the value your subaccount applies). v0.1 of the MCP server
does **not** refresh: when the token expires, tools return the server's 401 message and
the user restarts the server with a fresh token.

### 3.6 Local development — the mocked equivalent

`package.json` → `cds.requires.auth.kind: "mocked"` with users `alice` (PricingViewer)
and `bob` (PricingAdmin, any password). Basic auth `-u bob:x`. The `before('*')` guard
still runs: an unauthenticated request is 401 and `req.user` is always a named person,
so local behaviour matches production exactly except for how the credential is minted.
The MCP server takes `PRICING_USER=bob PRICING_PASSWORD=x` for this mode.

## 4. Deliberately NOT allowed

| Not allowed | Why | What happens |
|---|---|---|
| `client_credentials` token on `/rest/pricing/*` or `/rest/config/*` | No `user_name` → nobody to record | `403 NO_USER_PRINCIPAL` |
| A shared "pricing-integration" user with a password stored in an integration | Same as a technical client, with the extra risk of a leaked password | Not provisioned; there is no role collection for it |
| The MCP server holding a credential of its own | It would let any agent act as "the system" | It refuses to start without a *user* credential |
| `privileged` / `cds.User.Privileged` in request handlers | Bypasses the identity rule inside the process | Rejected by the same guard; seeds run at boot, outside a request |
| Identity fields in payloads (`requestedBy`, `approvedBy`, `publishedBy`) | Trivially spoofable | Ignored server-side; `req.user.id` is used |
| `grant_type=password` as the standard path | Ships user passwords through an integration | Not documented as supported |

Client-credentials tokens remain fine for infrastructure (health checks, a future
`cds deploy` job) — none of which are business endpoints.

## 4a. Temporary bring-up override (owner decision 2026-09-11)

`PRICING_REQUIRE_USER_PRINCIPAL=false` (a `cf set-env` on `tss-pricing-srv`, not a
repo default) lifts the "must be a named, non-technical user" rule so the app can be
exercised on CF before the approuter / token-exchange flow above exists to mint real
user tokens. Endpoints still require *some* valid token — no credential is still 401 —
this only lets a client-credentials token (e.g. a quick XSUAA service-key token) through
instead of 403 `NO_USER_PRINCIPAL`. Every write still stamps whatever `req.user.id` the
token actually carries (`system` for a client-credentials grant), so it's visible in the
data, not silent. **Unset this (or `cf unset-env`) once real user tokens are available —
it exists to unblock bring-up, not as a standing posture.**

## 5. Open items / verify on first deploy

- Approuter (`approuter/` + `xs-app.json`) so the React app and the token page exist.
- Whether `xs-security.json` needs `oauth2-configuration.redirect-uris` and
  `token-validity` set for the flows above.
- The exact Destination authentication type names available in the target subaccount
  for §3.2–3.4, and the C4C ↔ subaccount trust setup.
- Token refresh in the MCP server (currently: restart with a new token).
