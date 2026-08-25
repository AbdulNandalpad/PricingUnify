# TSS Pricing Engine — Requirements & Vision Document

**Version:** 1.0 · August 2026
**Owner:** Abdul Nandalpad
**Audience:** Claude Code (and any developer working on this repo)

---

## 0. INSTRUCTIONS FOR CLAUDE CODE — READ FIRST, EVERY SESSION

1. **Always read this document AND `CLAUDE.md` (project memory) before doing anything.** Every session, every task — no exceptions. If project memory and this doc conflict, ask; do not guess.
2. **The vision (Section 1) and approach (Section 2) are binding.** Do not simplify, substitute technologies, or "improve" architecture decisions without explicit approval.
3. **Update `CLAUDE.md` after every meaningful decision or change** so project memory stays current: what was built, what was decided, what is open.
4. **Never hardcode a pricing factor, rate, markup, or regional rule.** Everything numeric that affects a price is configuration (Section 6).
5. **The engine core must have zero SAP dependencies** (Section 4). If you find yourself importing anything SAP-specific inside `engine-core`, stop.
6. Ask before adding dependencies, changing the DB schema, or altering the API contract.

---

## 1. VISION

**A pricing system that never existed.** Not a landed cost calculator — an AI pricing workspace:

1. Connectors to external systems via **API6** (TSS internal middleware), its **own MCP server**, and standard **OAuth connectors**.
2. Cost sources: **manual entry, ERP-delivered (via API6), or AI-derived**.
3. **Landed cost calculated from regional settings** (Americas, Europe, China, India — extensible to any region).
4. **All cost-plus configuration is flexible** — factors, markups, adders, charges, constraints are data, not code.
5. System **suggests the relevant pricing type** for an item/quote by checking customer, product, and real-time market context.
6. User adds items and can **instruct the system in natural language how pricing should be done**; the system adapts, applies the logic dynamically, prices, and **explains exactly how** — full derivation, cost provenance, every step.
7. **All 5 pricing types** supported and ready to apply (cost-plus / landed cost first; others per config).
8. **Historical costs, prices, and sales (last years) accessed via API6 from BI** → best-price proposals and account insights.
9. Any needed **SAP or JDE E1 connections possible** (always through API6, never direct from the engine).
10. **UI embeddable as a mashup** in C4C — and in Salesforce, Dynamics, or any CRM — reading context from the host system and writing prices back.

**Business path:** Build for Trelleborg Sealing Solutions on SAP BTP → TSS approval → offer the same engine as a **Pricing-as-a-Service** SaaS product.

---

## 2. APPROACH & PRINCIPLES

1. **Engine calculates; API6 integrates.** The engine never connects to ERP directly. API6 delivers raw facts (costs, elements, routing data). All arithmetic lives in the engine. API6 must never pre-apply markups.
2. **Deterministic core, AI shell.** Calculations are pure, deterministic, replayable functions. AI suggests, interprets instructions, and explains — it never silently does arithmetic. (Parked details on AI-cost and user-instruction auditability: owner will guide when the time comes.)
3. **Rules are data.** A region is a config document (build-up sequence, factors with explicit basis, constraints), not a code branch. Adding a region = adding config.
4. **Every price is self-explaining.** Every response carries a full trace: each step, each rate, each cost source (system/table/field/timestamp), each rule version applied.
5. **Config visibility = error prevention.** Nothing incorrect can be "added silently" because every factor is declared, versioned, and reviewable.
6. **Object-agnostic by design.** The engine prices *items in context*, not quotes. Opportunity, quote, order, service — all are host objects that map into the same neutral pricing request (Section 7).
7. **Portable by design.** TSS runs it on BTP/HANA; the identical codebase must run on Postgres for the SaaS path. No HANA-specific SQL, no UI5.

---

## 3. SCOPE

### In scope (core)
- Landed cost calculation from ERP costs and regional logic — this is the main part.
- Regional configuration model for Americas, Europe, China, India.
- Cost resolution supporting multiple candidate costs (e.g., Americas: weighted average AND supplier cost options presented for user selection).
- Explanation/trace engine.
- Configuration UI (maker/checker later).
- Mashup-embeddable pricing workspace UI.
- API6 client (single inbound contract; see Section 8).
- MCP server exposing pricing capabilities.
- BI history access via API6 (past costs/prices/sales) for proposals and insights.

### Out of core scope (requestor/processor systems)
- C4C internals, ABSL, CPI Groovy — these are callers, not part of the engine.
- Direct ERP connectivity (always via API6).

---

## 4. ARCHITECTURE (LOCKED)

| Layer | Decision |
|---|---|
| Backend | **CAP Node.js on SAP BTP Cloud Foundry** (XSUAA auth, BTP destinations to API6) |
| Frontend | **React** — served from CF, mashup-portable. **Not Fiori/UI5.** |
| Engine core | **Plain Node module (`engine-core`) with zero SAP dependencies.** CAP is only its host. |
| Database | **HANA Cloud via CAP abstraction** at TSS; same codebase on **Postgres/Supabase** for SaaS. |
| Lock-ins forbidden | HANA-specific SQL, UI5, direct ERP calls, hardcoded rates |

### Suggested repo structure
```
/engine-core        # pure pricing kernel — no SAP, no CAP, no I/O
/config-model       # region config schemas, validation, versioning
/srv                # CAP services: pricing API, config API, trace API
/app                # React mashup UI
/mcp-server         # MCP server exposing pricing tools
/api6-client        # API6 contract client (single door to ERP/BI facts)
/tests/golden       # golden test set — real lines per region, verified outputs
CLAUDE.md           # project memory — read first, keep updated
```

---

## 5. ENGINE CORE REQUIREMENTS

### 5.1 The five element primitives
Every landed-cost element in every region is one of:

| Type | Behaviour |
|---|---|
| `BASE` | The resolved cost (moving avg, weighted avg, supplier catalog, etc.) |
| `FACTOR` | × multiplier on an **explicitly declared basis** (basis is REQUIRED — engine must refuse to run a FACTOR without one) |
| `ADDER` | + absolute amount (freight, duty, tariff as amounts) |
| `PER_LINE` | + amount ÷ quantity (pick charges) |
| `CONSTRAINT` | adjusts qty/price to a floor or step (MOLV, MOV, SPU rounding) |

Notes:
- MROQ is **routing input**, not a constraint — it selects the scenario before calculation.
- Composite factors (e.g., India +40%, China F&D ×1.32/×1.21) are tagged `COMPOSITE`, `allocatable: false`.
- Factor composition order (compound vs additive) is **declared in config per region**, never assumed.

### 5.2 Cost is a typed record, never a bare number
```
Cost { value, currency, priceUnit, uom,
       basis: STANDARD | MOVING_AVG | WEIGHTED_AVG | SUPPLIER_CATALOG | LAST_PURCHASE | TRANSFER | MANUAL | AI_DERIVED,
       source: { system, table, field, key },
       validFrom, retrievedAt,
       confidence: EXACT | FALLBACK | STALE | MISSING }
```
- Resolution may return a **set of candidates** with a default and selection policy (Americas pattern). User selection is recorded in the trace.
- `MISSING` is a first-class outcome (typed result naming the exact system/table/field), never an exception. `null` ≠ `0`.
- No silent fallback: if a fallback source was used, the result says so.

### 5.3 Determinism & replay
- Same input → same output, always. All external facts arrive in the request payload; the kernel performs no I/O.
- All money math in decimal (never float). Rounding rules declared in config (per element or final, mode).
- Currency conversion is an explicit, declared step in the build-up sequence (FX rate, type, date, position before/after factors), never implicit in an adapter.

### 5.4 Versioning & effective dating
- Every config document is versioned and effective-dated.
- Any historical quote must be repriceable exactly as it was priced on its price date.

### 5.5 Explanation trace
Every response includes: each build-up step with inputs/outputs, rates and their basis, cost candidate chosen (and by whom if user-selected), cost provenance, config version IDs, constraint passes (e.g., MOLV iterations, capped and logged).

---

## 6. CONFIGURATION MODEL

- A region = one config document: resolution ladder (stock class → origin of data → supplier → COO/OOD → cost basis → fallback chain) + ordered build-up of typed elements + constraints.
- Elements support conditional inclusion (`when` expressions).
- Nothing that affects a number is hardcoded. If a value could ever change for commercial reasons, it is config.
- **Golden test set** (`/tests/golden`): 30–50 real lines per region with verified expected outputs. Runs on every config change and every commit. A config change that breaks golden tests cannot be saved without explicit override + reason.

---

## 7. OBJECT-AGNOSTIC PRICING (opportunity / quote / order / service / any)

The engine never knows or cares what host object called it. Every caller maps into one neutral request:

```json
{
  "context": {
    "hostSystem": "C4C | SALESFORCE | DYNAMICS | API | MCP",
    "hostObjectType": "OPPORTUNITY | QUOTE | ORDER | SERVICE | CONTRACT | OTHER",
    "hostObjectId": "…",
    "purpose": "INDICATIVE | BINDING | REPRICE | SIMULATION"
  },
  "party":  { "customerId": "…", "salesOrg": "…" },
  "items":  [ { "partNumber": "…", "quantity": 500, "warehouse": "…" } ],
  "priceDate": "2026-08-21",
  "instructions": "optional natural-language pricing instructions"
}
```

- `purpose` drives behaviour, not object type: an opportunity typically asks `INDICATIVE` (estimates/fallbacks acceptable, flagged), an order asks `BINDING` (strict — no STALE/FALLBACK costs without explicit override), a quote sits between, `REPRICE` uses historical effective-dated config.
- Per-item independent success/failure (no all-or-nothing).
- The **mashup adapter layer** owns per-object context mapping (which fields to read from an Opportunity vs a Quote vs a Service Ticket, and where to write results back). New host object = new thin adapter, zero engine change.
- Service objects: service items (labor, parts, callout) are just items with different cost sources and possibly different build-ups — same five primitives, different config.

---

## 8. API6 CONTRACT PRINCIPLES

- One request from engine → API6 returns everything needed for a pricing run in one response: routing facts, cost candidate(s) with provenance, elements (freight/duty/tariff amounts, MOLV/MOV/SPU, FX rates). No mid-calculation callbacks.
- API6 delivers **raw facts only** — it never pre-applies markup or calculation. This boundary is non-negotiable.
- Quantity breaks: one API6 call per part; the engine varies quantity locally.
- BI history (past costs/prices/sales per customer/part) comes through API6 as a separate read.

---

## 9. PHASING (draft — owner drives)

1. **Phase 1 — Kernel + config model + golden tests.** One region end-to-end (simplest first: India or Europe), trace engine, API6 client stub with recorded payloads.
2. **Phase 2 — All four regions configured.** Config UI (read-only first), CAP API surface, versioning/effective dating.
3. **Phase 3 — Mashup UI in C4C.** Context mapping, candidate-cost selection UX, explanation view.
4. **Phase 4 — Intelligence.** BI history insights, best-price proposals, pricing-type suggestion, natural-language instructions, MCP server.
5. **Phase 5 — SaaS readiness.** Postgres deployment of identical codebase, multi-tenant model, OAuth connectors.

Parked items (owner will guide): AI-cost & instruction auditability details, SaaS/IP ownership, governance model, shadow-run/cutover plan.

---

## 10. NON-NEGOTIABLES (checklist for every PR)

- [ ] Read CLAUDE.md + this doc before starting
- [ ] No hardcoded rates/factors/regional rules
- [ ] No SAP imports inside `engine-core`
- [ ] No HANA-specific SQL, no UI5
- [ ] Every FACTOR has an explicit basis
- [ ] Decimal math only; declared rounding
- [ ] `null` ≠ `0`; MISSING is typed, not thrown
- [ ] Trace present on every priced result
- [ ] Golden tests pass
- [ ] CLAUDE.md updated with decisions/changes
