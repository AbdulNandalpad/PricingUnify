'use strict';

/** Served as the MCP resource pricing://guide so an agent can learn the domain once. */
module.exports = `# TSS Pricing Engine — guide for agents

## What it does
Calculates the LANDED COST of a part from its supplier cost plus the region's configured add-ons, and
optionally a SELLING PRICE from a margin. Everything numeric comes from versioned configuration — nothing
is a built-in constant, and every result carries a trace of how it was reached.

## Regions
EUROPE (origin SAP), AMERICAS (SMA), CHINA (CN), INDIA (IN). Each has its own build-up. Pass \`region\`, or a
\`customerOod\` that routes to one.

## Core concepts
- **Stock class**: MTS (made to stock) or NonMTS. It decides which charges apply (e.g. Europe adds
  freight/duty/tariff only for NonMTS). Resolved automatically; a part with an unresolved class prices
  as MISSING (STOCK_CLASS_UNRESOLVED) — pass \`stockClass\` or call get_item_attributes.
- **Supplier × warehouse**: freight, duty and tariff are percentage rates held per supplier and destination
  warehouse. Pass both \`supplier\` and \`warehouse\` to get them.
- **Price unit**: amounts are per \`priceUnit\` pieces (C4C uses 100). The math runs per piece and is scaled
  at the end, so small costs are not rounded away.
- **Margin**: marginPct is a share of the SELLING price: selling = landed ÷ (1 − m/100). manualPrice wins
  over marginPct. Some regions have predefined margin rules (priceBy = DEFAULT_RULE).
- **OPPORTUNITY** (hostObjectType) = cost only; no price or margin is ever returned.
- **Pricing type**: COST_PLUS (default) or PRICE_LIST (supplier price-list cost, then the same add-ons).

## Outcomes
Each line is PRICED or MISSING with a typed reason (NO_CANDIDATES, STOCK_CLASS_UNRESOLVED, RATE_MISSING,
AMOUNT_MISSING, PRICE_LIST_COST_NOT_FOUND, …). MISSING is a normal answer, not an error: report the reason
and the hint instead of retrying blindly. \`dataSource: DEMO_DATA\` means costs came from recorded demo data,
not the live cost gateway.

## Tools
price_items · explain_price · get_item_attributes · search_products · whoami
(+ get_region_config, list_suppliers when the operator enabled admin reads). This server never changes
configuration and never writes back to C4C.
`;
