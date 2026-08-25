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

## Repo map
```
engine-core/    pure pricing kernel (5 primitives: BASE, FACTOR, ADDER, PER_LINE, CONSTRAINT)
config-model/   region config schemas, validation, versioning (effective-dated)
srv/            CAP services (pricing API, config API, trace API)
app/            React mashup UI
mcp-server/     MCP server exposing pricing tools
api6-client/    single door to API6 (recorded payloads in api6-client/recorded for dev)
tests/golden/   verified real lines per region — must always pass
docs/           requirements doc + design docs
```

## Current phase
**Phase 1**: kernel + config model + golden tests, one region end-to-end (India or Europe first), API6 client stubbed with recorded payloads.
Status: `engine-core` kernel implemented and unit-tested against synthetic data. Still open: which region is "first" (deck leaves this for discussion), a real `config-model` validator, the `api6-client` stub with recorded payloads, and real finance-verified golden tests. A standalone dev UI (`app/`) now runs the kernel client-side for visualization, ahead of its normal Phase 3 slot.

## Parked (owner decides — do NOT implement without instruction)
- AI-cost / natural-language-instruction auditability details
- SaaS/IP ownership; governance model; shadow-run/cutover plan
- Repo currently on personal GitHub; TSS git migration later (trivial: add remote, push)

## Decision Log
- 2026-08-21: Requirements v1.0 finalized. Platform locked (CAP/CF + React + portable core). Object-agnostic model via `purpose` field. Repo scaffold created.
- 2026-08-25: Scaffold pushed to `AbdulNandalpad/PricingUnify` on GitHub (still personal, per parked TSS migration note). Concept deck (`TSS_Pricing_Engine_Concept.pptx`) added to `docs/` for reference alongside the binding requirements doc.
- 2026-08-25: `engine-core` implemented for real (kernel, cost resolution, 5 primitives, trace, decimal math, purpose gating) with unit tests (`node --test`, 6 passing) against a synthetic Europe-shaped build-up — not real TSS rates. `tests/golden/` still has no real finance-verified data, so `test:golden` remains a placeholder.
- 2026-08-25: Added a standalone dev UI in `app/` (Vite + React) at the owner's request, ahead of the Phase 3 mashup — it imports `@tss-pricing/engine-core` directly in the browser (no CAP/DB/API6 yet) so the kernel's build-up and trace are visible end-to-end. Uses the same synthetic sample data as the engine-core tests. `app` added to npm workspaces; `vite.config.js` sets `resolve.preserveSymlinks: true` + `optimizeDeps.include` so Vite's CJS→ESM interop works across the workspace symlink to engine-core. When `srv/` (CAP) exists, this UI should switch to calling the real pricing API instead of calling engine-core in-browser.
- (append new entries here, newest last)
