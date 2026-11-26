# TSS Pricing Engine — API & MCP guide

Two ways for other applications and agents to use the engine. Both are thin: all pricing logic and all
authorization live in the backend (`srv/`).

| | Use it when | Contract |
|---|---|---|
| **REST API** | an application calls the engine (a CRM, a quoting tool, a batch job) | [`docs/api/openapi.json`](api/openapi.json) — also served at `GET /api/openapi.json` |
| **MCP server** | an AI agent (Claude Desktop, Claude Code, any MCP client) should price items, explain a price, or look up parts | [`mcp-server/README.md`](../mcp-server/README.md) |

The MCP server is a client of the REST API. An agent can therefore never do more than the credentials it is
given allow, and it is deliberately **read/calculate-only**: no config saves, no write-back to C4C.

## REST API

Base path `/rest/pricing`. JSON in, JSON out. Every action takes `{ "payload": { … } }`.

| Operation | Role | What it does |
|---|---|---|
| `POST /price` | PricingViewer | Landed cost (and selling price) for 1–500 lines |
| `POST /fetchItemAttributes` | PricingViewer | Preview supplier / country / warehouse / stock class per part, no price |
| `POST /searchC4cProducts` | PricingViewer | Part-number type-ahead (C4C product master, else local catalog) |
| `POST /fetchKitComponents` | PricingViewer | A kit's components from the ERP behind its Origin of Data, with SAP-style item numbers |
| `GET /me` | any authenticated user | Identity and roles |

Configuration is a separate admin API (`/rest/config`, PricingAdmin only) and is not part of this contract.

### Example

```bash
curl -s -X POST "$BASE/rest/pricing/price" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"payload":{
        "region":"EUROPE",
        "items":[{"partNumber":"EU-T100","quantity":10,
                  "supplier":"ACME","warehouse":"EU01",
                  "margin":{"marginPct":"20"}}]}}'
```

```json
{ "config": { "region": "EUROPE", "version": "2026.08.0", "status": "ACTIVE" },
  "region": { "value": "EUROPE", "derivedBy": "EXPLICIT" },
  "api6Mode": "recorded",
  "items": [{ "partNumber": "EU-T100", "status": "PRICED",
              "result": { "unitPrice": "157.07", "currency": "EUR", "quantity": 10,
                          "sellingPrice": "196.34", "marginPct": "20", "priceBy": "MARGIN" },
              "trace": { "costCandidate": { "...": "..." }, "steps": [ "..." ] } }] }
```

### Rules every caller must know

- **Amounts are decimal strings**, never floats. Do not parse them into binary floating point for math.
- **`unitPrice` is the landed cost** (cost + the region's configured add-ons). A **selling price** appears only
  when a `margin`, a `manualPrice`, or a region's predefined margin rule applies.
- **Amounts are per `priceUnit` pieces** (C4C uses 100). The engine calculates per piece at full precision and
  scales just before rounding.
- **A line is `PRICED` or `MISSING`.** MISSING is a normal `200` answer with `missing.reason`
  (`NO_CANDIDATES`, `STOCK_CLASS_UNRESOLVED`, `RATE_MISSING`, …) — never an HTTP error and never a guess.
  One bad line does not fail the others.
- **`hostObjectType: "OPPORTUNITY"` is cost-only**: `landedCost` is returned, never a price or margin.
- **`api6Mode: "recorded"`** means costs came from demo data, not the live cost gateway. Treat such results as
  non-binding.
- **The trace is the explanation**: cost source and why it was chosen, each step with rate and running total,
  skipped steps with the unmet condition, rules applied, config version.
- Explicit values always win over automatic resolution (`stockClass`, `supplierCountry`, `region`, …).
- **Kits (sales BOMs), any region, modeled on standard SAP SD.** A line with `components` (or `itemType: "ZKIT"` and no components) is a kit header.
  Components are fetched from the ERP behind the header's Origin of Data through API6 `getKitComponents` — one common endpoint (API6 routes to the ERP by Origin of Data) unless an admin has given that Origin of Data its own individual endpoint (Connections). Only part number and quantity are used; the answer's `usage` (S/O) and `itemShortNumber` are ignored and every component is priced.
  Component quantity = kit quantity × quantity in one kit, and each component is priced at its real total quantity. Pricing is at **header level**: the
  header's cost, price and margin are the roll-up of its components, and a margin on the header applies to every component. Item numbers follow SAP's
  sub-item rule (header 10 → components 11, 12, 13 → next item 20). A price typed on the header is refused; a kit whose components cannot all be priced is MISSING.
- Limit: 500 lines per request (kit components count). Larger → `413`; split the request.

### Status codes

`200` priced run (check each line) · `400` malformed request · `401` no/invalid credentials ·
`403` missing role · `413` too many lines · `422` no effective configuration for region / sales org / date.

### Authentication

| Environment | How |
|---|---|
| Local dev | HTTP Basic with the mocked users: `alice` (PricingViewer), `bob` (PricingAdmin + PricingViewer), `carol` (no role); password `x`. Start with `npm run start:srv` (port 4004). |
| BTP | XSUAA bearer token. Pricing needs the `PricingViewer` scope. **Interactive users** get it from their role collection through the approuter. **Machine clients** (another app, a scheduled job, the MCP server in shared mode) use the OAuth2 client-credentials grant against the XSUAA instance and call the **srv URL directly**; the token must carry `PricingViewer`, which means the client has to be granted that scope (`grant-as-authority-to-apps` on the scope plus `authorities` on the consumer's own XSUAA instance, or a service key created with that authority). |

> **Not yet exercised on BTP.** The role/scope model and `xs-security.json` are in place and the service-level
> enforcement is test-pinned locally, but the machine-client grant above has not been set up or tested against a
> real subaccount, and `xs-security.json` declares no consumer apps yet. The security review also recommends a
> dedicated scope for the C4C facade (server-to-server) calls — an owner decision, not yet made.

## MCP server

Tools: `price_items`, `explain_price`, `get_item_attributes`, `search_products`, `whoami`; with `--admin`,
read-only `get_region_config` and `list_suppliers`. Resource `pricing://guide`. See
[`mcp-server/README.md`](../mcp-server/README.md) for installation and client configuration.
