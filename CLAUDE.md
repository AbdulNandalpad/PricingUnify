# CLAUDE.md — Project Memory

> **READ THIS FILE AND `docs/PRICING_ENGINE_REQUIREMENTS.md` FIRST, EVERY SESSION, BEFORE ANY TASK.**
> The requirements doc is binding: vision, approach, architecture are locked. Do not simplify or substitute. If unclear — ASK, don't guess.
> **UPDATE the Decision Log below after every meaningful decision or change.**

## What this is
TSS Pricing Engine — an AI pricing workspace ("a pricing system that never existed"). Landed cost calculation from ERP costs + regional config, all pricing types, explainable traces, embeddable as a mashup in any CRM. Built for Trelleborg Sealing Solutions on SAP BTP; same codebase becomes a Pricing-as-a-Service SaaS later.

## Locked architecture (do not change without owner approval)
- Backend: CAP Node.js on SAP BTP Cloud Foundry (XSUAA, destinations to API6)
- Frontend: React (NOT Fiori/UI5) — mashup-portable
- Engine core: plain Node module, ZERO SAP dependencies (`engine-core/`)
- DB: HANA Cloud via CAP abstraction; must also run on Postgres (SaaS). NO HANA-specific SQL.
- All ERP/BI data via API6 only. Engine never integrates directly. API6 delivers raw facts, never pre-applied calculations.

## Non-negotiables (every PR)
- No hardcoded rates/factors/regional rules — everything numeric affecting a price is config
- No SAP imports in engine-core; no HANA SQL; no UI5
- Every FACTOR declares an explicit basis (engine refuses to run without it)
- Decimal math only (decimal.js), declared rounding; null ≠ 0; MISSING is a typed outcome, not an exception
- Deterministic kernel: no I/O inside engine-core; same input → same output
- Trace on every priced result; golden tests (`tests/golden/`) pass before merge
- Object-agnostic: engine prices items in context via neutral request; `purpose` (INDICATIVE|BINDING|REPRICE) drives behaviour, not host object type
- AI never writes a config directly: a natural-language instruction only ever produces a `PENDING_REVIEW` suggestion (config-model); applying one requires an explicit human `approvedBy` and re-validates against every non-negotiable first

## Repo map
```
engine-core/    pure pricing kernel (5 primitives: BASE, FACTOR, ADDER, PER_LINE, CONSTRAINT)
config-model/   config schemas, validation, versioning (effective-dated), scoped by (region, salesOrg)
srv/            CAP services (pricing API, config API, trace API)
app/            React mashup UI
mcp-server/     MCP server exposing pricing tools
api6-client/    single door to API6 (recorded payloads in api6-client/recorded for dev)
tests/golden/   verified real lines per region — must always pass
docs/           requirements doc + design docs
```

## Current phase
**Phase 1**: kernel + config model + golden tests, one region end-to-end (India or Europe first), API6 client stubbed with recorded payloads.
Status: `engine-core` kernel implemented and unit-tested. `config-model` implemented: JSON-Schema-validated config tables, an in-memory versioned/effective-dated store, and the AI natural-language-instruction → suggestion → human-approval pipeline (see `config-model/README.md`). Still open: which region is "first" (deck leaves this for discussion), the `api6-client` stub with recorded payloads, and real finance-verified golden tests. A standalone dev UI (`app/`) runs the kernel client-side for visualization, ahead of its normal Phase 3 slot.

## Parked (owner decides — do NOT implement without instruction)
- AI-cost tracking (token/$ spend per suggestion) — the auditability *shape* (instruction, patch, rationale, confidence, model, reviewer) is now implemented in config-model; cost metering is not
- SaaS/IP ownership; governance model beyond single-approver (maker/checker, who may approve what) — currently any `approvedBy` string is accepted, no role check
- Repo currently on personal GitHub; TSS git migration later (trivial: add remote, push)

## Decision Log
- 2026-08-21: Requirements v1.0 finalized. Platform locked (CAP/CF + React + portable core). Object-agnostic model via `purpose` field. Repo scaffold created.
- 2026-08-25: Scaffold pushed to `AbdulNandalpad/PricingUnify` on GitHub (still personal, per parked TSS migration note). Concept deck (`TSS_Pricing_Engine_Concept.pptx`) added to `docs/` for reference alongside the binding requirements doc.
- 2026-08-25: `engine-core` implemented for real (kernel, cost resolution, 5 primitives, trace, decimal math, purpose gating) with unit tests (`node --test`, 6 passing) against a synthetic Europe-shaped build-up — not real TSS rates. `tests/golden/` still has no real finance-verified data, so `test:golden` remains a placeholder.
- 2026-08-25: Added a standalone dev UI in `app/` (Vite + React) at the owner's request, ahead of the Phase 3 mashup — it imports `@tss-pricing/engine-core` directly in the browser (no CAP/DB/API6 yet) so the kernel's build-up and trace are visible end-to-end. Uses the same synthetic sample data as the engine-core tests. `app` added to npm workspaces; `vite.config.js` sets `resolve.preserveSymlinks: true` + `optimizeDeps.include` so Vite's CJS→ESM interop works across the workspace symlink to engine-core. When `srv/` (CAP) exists, this UI should switch to calling the real pricing API instead of calling engine-core in-browser.
- 2026-08-25: `config-model` implemented at the owner's explicit instruction to unlock the previously-parked AI/instruction work early. Six tables: `region-config`, `build-up-element`, `constraint`, `resolution-rule`, `ai-suggestion`, plus a `provenance` fragment embedded on every one of them (source HUMAN|AI_SUGGESTED|AI_DERIVED|IMPORTED, confidence, rationale, approver) — every table is AI-ready from scratch, not just region-config. Added the AI pipeline: `suggestConfigChange()` (calls an AI client — real `@anthropic-ai/sdk` client or a `createFakeClient()` for hermetic tests — to turn a natural-language instruction into a JSON-Patch `AiSuggestion`, status `PENDING_REVIEW`) and `applySuggestion()` (requires a human `approvedBy`, re-validates against schema + the FACTOR-basis rule before creating a new version — throws and leaves the store untouched otherwise). No config is ever written by AI without an explicit human approval step. 19 unit tests pass, including one that prices an AI-approved config change through the real `engine-core` kernel. Also fixed a bug in the original scaffolded `region-config.schema.json`: it listed CONSTRAINT as a valid `buildUp` element type, but the kernel (built earlier this session) applies constraints from a separate `constraints[]` array after the build-up — schema now matches kernel behavior. `config-version-history` was considered as a seventh table but dropped: the store already keeps every version ever saved, so the version list *is* the history (see config-model/README.md).
- 2026-08-25: `config-model` extended to scope config documents by **(region, salesOrg)**, not region alone, per owner instruction — matches the object-agnostic request's `party: { customerId, salesOrg }` (requirements §7). `salesOrg: "*"` is a region-wide default; `region-config` and `ai-suggestion` both require `salesOrg` now. `ConfigStore` is keyed by `(region, salesOrg)`; `getEffectiveAsOf(region, salesOrg, date)` tries the sales-org-specific bucket first and falls back to the region's `"*"` bucket — a sales org only needs its own document where it actually diverges. Fixed a real bug this surfaced: superseding a version didn't close the old one's `validTo`, so two versions sharing a `validFrom` (e.g. an AI suggestion applied with no explicit new effective date) could both match the same lookup date, and `getEffectiveAsOf` would return whichever was inserted first rather than the actually-current one; `saveVersion` now closes the superseded version's window at the new version's `validFrom`. 24 unit tests pass (was 19).
- (append new entries here, newest last)
