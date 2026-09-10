# PricingUnify — TSS Pricing Engine (v2)

A pricing engine for Trelleborg Sealing Solutions that prices any line — quote,
opportunity, order, service — from raw ERP facts and versioned, effective-dated rules,
and can always say exactly why. Every result carries a step-by-step trace; anything it
cannot price is a typed `MISSING`/`BLOCKED`, never a guess. Rules are data with a draft →
publish lifecycle and four-eyes review; AI may *propose* a change but a person approves
and a person publishes. The REST API and the MCP server are first-class from the base,
and every call runs **on behalf of a named user** — there is no technical identity.
CAP Node.js on SAP BTP for TSS, the identical codebase on Postgres for the SaaS path.

**Start here:** `CLAUDE.md` (project memory) → `docs/PRICING_ENGINE_REQUIREMENTS.md`
(binding vision) → `docs/ARCHITECTURE_V2.md` (binding build contract for v2).

## Three pricing techniques

| Technique | What it is | Sell price |
|---|---|---|
| **Cost plus** (landed cost) | Regional build-up over the resolved cost: markup, freight/duty/tariff, pick, MOLV/MOQ, per (region × stock class × OOD), plus supplier quantity-break tables as a cost source | landed cost ÷ (1 − region default margin), adjustable per line |
| **Price list** | Rows per part with tiers, matched most-specific-wins on customer / tier / region / product attributes, effective-dated | the list value, then customer discount and constraints |
| **Catalog + formula** | A catalog rate per (spec, variant) **or** a formula in a closed DSL (`diameter_mm * cost.ptfe_rate_per_mm …`) over effective-dated cost inputs | catalog rate is a sell price; a formula result is a cost — margin and margin floor apply |

Routing rules decide which technique a line gets; a user can override per line and the
trace records `routedBy`. `purpose` (INDICATIVE / BINDING / REPRICE) stays an API
concept: BINDING refuses stale or fallback costs.

## Run it

```bash
npm install
npm test                              # every workspace: engine-core, config-model, api6-client, srv, mcp-server
npm run test:golden                   # finance-verifiable lines per region and technique

node srv/server.js                    # backend  http://localhost:4004  (SQLite db.sqlite; mocked users alice=viewer, bob=admin, any password)
npm run dev --workspace=app           # React UI http://localhost:5173  (white / navy; "signed in as" picker)

PRICING_USER=bob PRICING_PASSWORD=x node mcp-server/src/index.js     # MCP server over stdio, acting as bob
```

No external credentials needed: API6 runs on recorded payloads and the AI-suggestion
pipeline reports `AI_NOT_CONFIGURED` until `ANTHROPIC_API_KEY` is set.

## Repo map

```
engine-core/    pure kernel — cost plus, price list, catalog + formula, routing, formula DSL, rules, trace. decimal.js, no I/O
config-model/   JSON schemas + validation for every rules document; versioned store (DRAFT → ACTIVE → SUPERSEDED) over a pluggable backend; diff; AI suggestions
srv/            CAP Node.js — PricingService + ConfigService (REST), persistence (SQLite dev / HANA prod / Postgres SaaS), on-behalf-of enforcement, seeds
app/            React (Vite) — price calculator, pricing rules, go live & history
mcp-server/     MCP server (stdio) — the same capabilities as tools, forwarding the user's own credential; never publishes
api6-client/    single door to ERP/BI facts; recorded payloads in dev
tests/golden/   verification lines per region and technique; CI-blocking
docs/           requirements, architecture contract, deployment, on-behalf-of, concept deck
```

## Docs

- `docs/PRICING_ENGINE_REQUIREMENTS.md` — vision, principles, non-negotiables (binding)
- `docs/ARCHITECTURE_V2.md` — the v2 build contract: kernel, documents, REST, MCP, app, tests
- `docs/ON_BEHALF_OF_USER.md` — the identity rule and how every caller gets a user token
- `docs/DEPLOYMENT.md` — Cloud Foundry runbook: XSUAA, HANA, push, roles, MCP
- `mcp-server/README.md` — tool table and Claude Desktop / Claude Code wiring
- `CLAUDE.md` — project memory and decision log
