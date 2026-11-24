# app-c4c — SAPUI5 pricing app (C4C mashup + standalone)

SAPUI5 freestyle app (sap.m + sap.ui.table, compact density, no shell header — it runs
inside a C4C iframe). Replaces the frozen React `app/` as the product UI (owner decision
2026-11-24).

## Run locally

```bash
node srv/server.js         # from the repo root
# then open http://localhost:4004/app-c4c/index.html
```

Sign in with the mocked users when the browser asks: `bob` / `x` (PricingAdmin — gets the
Admin view via `?mode=admin`), `alice` / `x` (PricingViewer — pricing only), password is
always `x`.

## URL parameters (what C4C passes)

- `objectType` — `QUOTE` (default) or `OPPORTUNITY`. An OPPORTUNITY is cost-only: no price,
  no margin anywhere.
- `objectId` — the host object's id. Without one the app runs standalone and shows a
  search field (C4C item loading arrives with the Phase 5 adapter; until then items are
  entered manually).
- `mode` — `admin` routes a PricingAdmin straight to the Admin view.
- `sap-theme` — UI5 theme, default `sap_horizon`.

## Views

- **Pricing** (`view/Pricing.view.xml`) — the Viewer screen: header context, Fetch Costs /
  Calculate Prices (QUOTE only) / Write Back to C4C, one row per item with status, cost,
  landed cost, price and margin, row press opens the full calculation trace. No config
  anywhere in this view.
- **Admin** (`view/Admin.view.xml`) — PricingAdmin only (enforced server-side; the UI only
  mirrors it): Regions / Cost Rules / Cost Plus Rules / Price Lists (read-only WSO2
  browser) / Versions / Simulate.
