# PricingUnify v2 — Architecture & Build Contract

**Status:** binding for the v2 rebuild (owner decision 2026-09-10, after the clickable
prototype was validated). Supplements `PRICING_ENGINE_REQUIREMENTS.md` (still binding:
CAP Node on BTP, React not UI5, engine-core with zero SAP deps, decimal math only,
nothing numeric hardcoded, typed MISSING, trace on every result). Where this file is
more specific, this file wins.

Prototype the owner validated: https://claude.ai/code/artifact/280e797b-a105-4864-82e4-9af45fd93d18

## 0. What changed and why

PricingUnify (this repo, the TSS deliverable) reached one technique (cost plus) on an
in-memory store. BPMSquare's pricing engine (the owner's other product) already proves
the harder pieces: attribute rules resolved most-specific-wins, a cost-source ladder
with freshness, a closed-AST formula DSL, draft → publish versioning, stored traces.
v2 takes **BPMSquare's methodology** and **PricingUnify's user-facing UI**, and keeps
every piece of TSS regional complexity that already exists.

Owner decisions, verbatim intent:
1. Three pricing types only: **cost plus** (landed cost), **price list**, **catalog + formula**.
2. UI stays **white + navy blue** exactly as the prototype. Never dark/orange.
3. **REST API and MCP server are built in from the base**, not a later phase.
4. **On behalf of user is enforced**: every call carries a real user; nothing runs as an
   anonymous technical client.
5. Cost plus sell price = landed cost ÷ (1 − region default margin), adjustable per line.
6. A catalog rate is a sell price (no margin on it). A formula result is a cost (margin
   + margin floor apply). A price list is a sell price. TSS's supplier quantity-break
   table stays what it is today: a cost source inside cost plus.
7. `purpose` (INDICATIVE/BINDING/REPRICE) stays an API concept, out of the UI.

## 1. Workspaces (unchanged layout, new responsibilities)

```
engine-core/    pure kernel — cost plus (5 primitives), price list, catalog + formula,
                routing, formula DSL, rules resolution, unified trace. decimal.js. No I/O.
config-model/   JSON schemas + validation for every config document, versioned store with
                a pluggable persistence backend, DRAFT → publish, diff, AI suggestions.
srv/            CAP Node.js: PricingService + ConfigService (REST), CDS persistence
                (SQLite in dev, HANA/Postgres in prod), on-behalf-of enforcement, seeds.
mcp-server/     MCP server (stdio) exposing the same capabilities as tools, forwarding
                the caller's user token to srv. Never holds its own credential.
api6-client/    unchanged — single door to ERP/BI facts, recorded payloads in dev.
app/            React (Vite) — the prototype's screens, calling srv.
tests/golden/   finance-verifiable lines per region and per technique; runner is real.
```

## 2. engine-core

### 2.1 Entry point

```js
const { priceItems } = require('@tss-pricing/engine-core');
priceItems({ request, facts, config }) -> { items: Line[] }
```

- `request` — the neutral request (§7 of the requirements), plus `party.tier`,
  `party.customerId`, `party.region` filled in by srv. Items may carry `pricingType`
  (user override: `COST_PLUS | PRICE_LIST | CATALOG_FORMULA`) and `book`.
- `facts` — API6 shape as today (`costs`, `elements`, `classification`, `qtyBreaks`,
  `fx`, `itemAttributes`) **plus** `items[partNumber]` = product attributes
  (`family`, `spec`, `variant`, numeric attributes such as `diameter_mm`) — API6/C4C
  master data, never typed by the engine.
- `config` — `{ region: RegionPricingConfig, priceLists: {id: PriceList},
  catalogs: {id: CatalogBook}, routing: RoutingRules, suppliers?: {...} }`.
  srv resolves all of them as-of `priceDate` before calling the kernel.

`price()` (the existing cost-plus kernel) stays exported and unchanged in behaviour
except for the sell-price addition in §2.2.

### 2.2 Unified line result

```js
{
  partNumber, status: 'PRICED' | 'MISSING' | 'BLOCKED',
  technique: 'COST_PLUS' | 'PRICE_LIST' | 'CATALOG_FORMULA',
  book: string | null,              // price list / catalog id, null for cost plus
  routedBy: 'USER' | 'RULE:<n>' | 'DEFAULT',
  result?: { unitPrice, landedCost, margin, currency, quantity },   // strings (decimal)
  flags: [{ level: 'info'|'warn'|'crit', code, text }],
  missing?: { reason, detail },
  trace: { technique, region, configVersions: {...}, steps: Step[], ... per technique }
}
```

- Cost plus: `landedCost` is the existing build-up result; `unitPrice = landedCost /
  (1 − margin)` where `margin` = `item.marginOverride ?? region.sell.defaultMargin`.
  A region without a `sell` section prices `unitPrice = landedCost`, `margin = null`
  (backward compatible with every existing test).
- Price list: `landedCost = null`, `margin = null`.
- Catalog: catalog row → `landedCost = null`; formula → `landedCost` = formula
  result + freight, `margin` = realised margin after discount.

`Step` = `{ id, type, delta, runningTotal, note, skipped, missing }` for every technique
(`type` ∈ BASE FACTOR ADDER PER_LINE RULE FORMULA PERCENT). Skipped steps stay in the
trace with `skipped: true` and the reason — a binding audit sees why a branch did not
apply.

### 2.3 Rules resolution (shared by price list, catalog margins/discounts)

`rules.js`: `resolveRows(rows, ctxAttrs, dimensions, date)` → `{ winner, candidates,
ambiguous }`. A row matches when every attribute in `row.match` equals the context.
Specificity = Σ weight of matched dimensions. Highest wins; equal specificity between
two live matches is `AMBIGUOUS_RULE` (typed MISSING), never resolved by order or chance.
Validity `validFrom/validTo` on the row is checked against `priceDate`.
`tierValue(tiers, quantity)` picks the highest `from ≤ quantity`.

### 2.4 Formula DSL (`formula.js`)

Own tokenizer + Pratt parser to a closed AST; evaluation in decimal.js. Grammar v1:
numbers, identifiers with dots (`diameter_mm`, `cost.ptfe_rate_per_mm`, `quantity`),
`+ - * / ^`, parentheses, unary minus, `min max round abs`. No other syntax, no `eval`,
no `Function`. `parse(src)` throws a typed error with position; `evaluate(ast, vars)`
returns `{ value: Decimal, used: {name: value} }` and throws `FORMULA_INPUT_MISSING`
naming the variable when one is absent — the kernel turns that into a typed MISSING.
`dsl_version: 1` is stored on every catalog book.

### 2.5 Routing (`routing.js`)

`resolveTechnique(item, productAttrs, config)`:
1. `item.pricingType` → `routedBy: 'USER'` (book from `item.book` or the first book of
   that type whose `appliesWhen` fits).
2. `config.routing.rules` in order: rule `when` (attribute equality on product
   attributes, e.g. `{family: 'O-Rings'}`) AND the target book's `appliesWhen`
   (`region`, product attributes) → `routedBy: 'RULE:<index>'`.
3. Else `COST_PLUS` with the region config → `routedBy: 'DEFAULT'`.

### 2.6 Price list technique (`priceList.js`)

Book shape: `{ id, name, currency, appliesWhen, dimensions[{attr,label,weight}],
rows[{ part, match, tiers[{from,value}], validFrom, validTo }],
discount[{ match, value }], constraints[] }` (constraints reuse the cost-plus
CONSTRAINT primitives — FLOOR/STEP/MIN_QTY with literal `min`/`step`).
Steps: LIST_PRICE (RULE) → CUST_DISC (PERCENT, may skip) → constraints → rounding.
Context attributes: `customer`, `tier`, `region`, `salesOrg`, plus any product
attribute — dimensions decide which of these matter.

### 2.7 Catalog + formula technique (`catalog.js`)

Book shape: `{ id, name, currency, appliesWhen, dsl_version, matchOn: ['spec','variant'],
rows[{ match:{spec,variant,...}, rate }], fallbackFormula, costInputs{ name: { value,
unit, validFrom, validTo, source } }, freight, margin[{match,value}], floor,
discount[{match,value}], rounding }`.
Steps: CATALOG_RATE (RULE) **or** FORMULA_COST (FORMULA) → FREIGHT (ADDER) →
MARGIN (PERCENT; skipped with a note on catalog lines) → CUST_DISC → floor check
(formula lines only: realised margin < floor → flag `MARGIN_FLOOR`, level `crit`).
Cost inputs are effective-dated: the value in force on `priceDate` is used and named
in the trace with its validFrom and source.

### 2.8 Purpose gate

Unchanged: BINDING refuses FALLBACK/STALE costs (`BLOCKED`). Catalog formula lines
whose cost input is `AI_DERIVED` or `estimate`-sourced are FALLBACK for this purpose.

## 3. config-model

### 3.1 Documents (all versioned, effective-dated, provenance-stamped)

| kind | key | new in v2 |
|---|---|---|
| `region-config` | (region, salesOrg) | + `sell: { defaultMargin, rounding }` |
| `supplier-config` | supplier | — |
| `region-route` | (ood, salesOrg) | — |
| `party-config` | customerId | + `tier` |
| `price-list` | id | **new** (§2.6) |
| `catalog-book` | id | **new** (§2.7) |
| `routing-rules` | `'*'` (one document) | **new** (§2.5) |
| `ai-suggestion` | id | now targets any document kind (`targetKind`, `targetKey`) |

Every document: `{ version, status: DRAFT|ACTIVE|SUPERSEDED|REJECTED, supersedes,
validFrom, validTo, provenance }`. `status: DRAFT` documents are never used for
pricing; `publish(kind, key, version, {effectiveFrom, publishedBy})` flips a DRAFT to
ACTIVE and supersedes the previous ACTIVE, closing its window — atomically through the
backend.

### 3.2 Validation

Schema (ajv) + business rules, run on save **and** again on publish:
- FACTOR basis rule, BASE present, unique ids (as today).
- Price list: no two rows for the same part with identical `match` and overlapping
  validity; tiers start at 0 and strictly increase; every `match` key is a declared
  dimension.
- Catalog: `fallbackFormula` parses (engine-core's parser — config-model depends on
  engine-core for this alone); every `cost.*` the formula references exists in
  `costInputs`; rows unique on `matchOn`.
- Routing: every rule points at an existing book of the stated type.

### 3.3 Store & persistence

`ConfigStore` keeps the in-memory index it has today but reads/writes through a
`StoreBackend`:

```js
{ async loadAll() -> Document[], async append(doc), async update(doc) }
```

`MemoryBackend` (tests) and, in srv, `CdsBackend` over the `ConfigDocuments` entity.
The store is loaded once at boot and written through on every save/publish. Volume is
small (hundreds of documents); no query layer is needed.

`diff(a, b)` → flat `[ { path, from, to } ]` for any two documents — the "Changes in
this draft" table and the version compare view.

## 4. srv (CAP)

### 4.1 Persistence (`db/schema.cds`)

```
entity ConfigDocuments { key kind: String; key docKey: String; key version: String;
  status; validFrom: Date; validTo: Date; doc: LargeString; createdBy; createdAt; }
entity PricingDocuments { key ID: UUID; requestedBy; hostSystem; hostObjectType;
  hostObjectId; purpose; region; salesOrg; priceDate: Date; configVersions: LargeString;
  request: LargeString; result: LargeString; createdAt: Timestamp; }
```

Dev: `@cap-js/sqlite`, file `db.sqlite` (gitignored), `cds deploy` on first boot, seed
only when `ConfigDocuments` is empty. Prod: `[production]` profile → `hana`, or
`postgres` via `@cap-js/postgres` for the SaaS path. No HANA-specific SQL anywhere.

### 4.2 On behalf of user — enforced

- Every service endpoint is `@requires: 'authenticated-user'` or a role. There are no
  technical-client endpoints.
- A CAP `before('*')` handler on both services rejects (403 `NO_USER_PRINCIPAL`) any
  request whose `req.user` is anonymous, `privileged`, or a client-credentials token
  without a user id (XSUAA: `grant_type=client_credentials` → no `user_name`).
- `requestedBy` on every pricing document, `provenance.authoredBy` / `publishedBy` on
  every config write, `reviewedBy` on suggestions = `req.user.id`. Payload-supplied
  identities are ignored.
- Integrations (C4C, MCP, Build Apps) obtain a **user token** for the acting user
  (XSUAA JWT-bearer token exchange / principal propagation) and send it as
  `Authorization: Bearer`. `DEPLOYMENT.md` documents the exchange. Locally, mocked
  users `alice` (PricingViewer) and `bob` (PricingAdmin) via Basic auth, as today.
- Roles: `PricingViewer` — price, explain, read rules. `PricingAdmin` — edit drafts,
  publish, review AI suggestions. (Approver as a distinct role is parked with topic 9.)

### 4.3 REST contract (`@protocol: 'rest'`, paths `/rest/pricing/*`, `/rest/config/*`)

PricingService
- `POST price { payload }` → `{ config: {...versions}, region, priceDate, requestedBy,
  documentId, items[] }` — stores a `PricingDocument` per call.
- `POST fetchItemAttributes { payload }` — as today, plus product attributes.
- `GET getPricingDocument(id)` → stored request + result + trace (the "why" of a sent quote).
- `GET listPricingDocuments(hostObjectId?, from?, to?, limit?)`.
- `POST simulate { payload: { items?, documentIds?, draft: { kind, key, version } } }`
  → each line priced with LIVE and with the DRAFT, deltas, floor crossings, dead rows.
- `GET whoami` → `{ id, roles }`.

ConfigService (reads: authenticated-user; writes: PricingAdmin)
- `GET getEffective(kind, key, asOf)`, `GET listVersions(kind, key)`,
  `GET getVersion(kind, key, version)`, `GET diff(kind, key, a, b)`.
- `GET listBooks(kind)` — price lists / catalogs summary; `GET listSuppliers(asOf)`.
- `POST saveDraft { payload: { kind, doc } }` — validates, stores as DRAFT
  (version auto `YYYY-MM-DD-rN` unless given), provenance stamped server-side.
- `POST publish { payload: { kind, key, version, effectiveFrom, note } }`.
- `POST discardDraft { payload: { kind, key, version } }`.
- `POST saveActive { payload }` — save + publish in one call (the old direct-save
  behaviour; kept for scripts and the Suppliers sheet).
- AI: `POST suggestChange`, `POST approveSuggestion`, `POST rejectSuggestion`,
  `GET listSuggestions` — now for any document kind; approval produces a DRAFT, not
  an ACTIVE version (four-eyes: someone still publishes).
- Legacy names (`getEffectiveConfig`, `saveRegionConfig`, `getEffectiveSupplierConfig`,
  …) remain as thin aliases so the existing srv tests keep passing until rewritten.

## 5. mcp-server

`@modelcontextprotocol/sdk`, stdio transport. Startup requires **one** of
`PRICING_USER_TOKEN` (bearer, production) or `PRICING_USER` + `PRICING_PASSWORD`
(mocked local auth); refuses to start otherwise — there is no service identity. Every
tool call forwards that credential to `PRICING_API_BASE` (default
`http://localhost:4004`). Tools:

| tool | calls | role |
|---|---|---|
| `price_items` | `POST /rest/pricing/price` | viewer |
| `explain_price` | `GET getPricingDocument` | viewer |
| `fetch_item_attributes` | `POST fetchItemAttributes` | viewer |
| `get_pricing_rules` | `GET getEffective` (region / price list / catalog / routing) | viewer |
| `list_books` | `GET listBooks` | viewer |
| `simulate_change` | `POST simulate` | viewer |
| `propose_rule_change` | `POST suggestChange` | admin |
| `list_pending_suggestions` | `GET listSuggestions(status=PENDING_REVIEW)` | admin |

No tool publishes. Going live is a human action in the app.

## 6. app (React, Vite)

Screens and behaviour = the validated prototype, one to one:
- **Price calculator** — customer, region (from the customer's data origin, editable),
  price date, line grid (part, qty, pricing type chip with override, supplier,
  warehouse, stock class, additional cost behind "More columns"), status, unit cost,
  unit price, margin, line total, `why?` → side drawer with the technique-specific
  trace, margin slider on cost-plus lines. Kits keep the inline component editor.
- **Pricing rules** — Regions (build-up sheet, cost source order, sell margin, order
  rules, stock class map, additional-cost options), Price lists, Catalog + formula,
  Which type applies, Suppliers. Every edit → `saveDraft`; the "Unsaved changes"
  banner shows the diff count.
- **Go live & history** — what would change (simulate), changes in this draft (diff),
  publish with note + effective date, version history with as-of pricing, plain
  language rule change (AI suggestion → draft).
- Theme: the prototype's light tokens (`--navy #1e2761` on white), IBM Plex Sans /
  Plex Mono. Light only in the app.
- Auth: local "signed in as" picker (alice/bob) as today; in production the approuter
  session. Edit controls hidden without PricingAdmin; the server enforces regardless.

## 7. Tests

- engine-core: existing suites + `rules`, `formula`, `priceList`, `catalog`, `routing`,
  `priceItems` end-to-end; decimal exactness asserted as strings.
- config-model: schemas, business rules (ambiguous rows, formula references),
  publish/supersede through `MemoryBackend`, diff.
- srv: spawn the server with `CDS_ENV=test` (in-memory SQLite), assert auth (401 no
  user, 403 client-credentials shape), pricing per technique, draft/publish lifecycle,
  stored pricing documents, simulate.
- golden: `tests/golden/<region>/*.json` — verification parts (`EU-T100` 130.78 EUR
  qty 10, `CN-T100`, `IN-T100`, `US-T100`), price list `OR-25X3-NBR`, catalog
  `PTFE-BRG-120/137`; `npm run test:golden` runs them through `priceItems` and fails
  on any difference. CI-blocking.

## 8. Build order (this rebuild)

1. engine-core (this doc §2) — the contract everything else compiles against.
2. config-model schemas/validation/store backend + srv persistence and services (§3–4).
3. app (§6) and mcp-server (§5) in parallel against §4.3.
4. Golden tests, seeds for all regions + the EU price list + the PTFE catalog,
   docs (CLAUDE.md decision log, README, DEPLOYMENT.md on-behalf-of section,
   mcp-server/README).
