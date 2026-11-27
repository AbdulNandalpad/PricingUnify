/**
 * Pricing API. CAP is only the host — see pricing-service.js. It resolves the effective
 * (region, salesOrg) config from config-model, resolves facts from API6 (recorded payloads
 * in dev), and hands both to engine-core's price() unchanged. No pricing logic lives here.
 *
 * Role model (Phase 2, owner spec 2026-11-24): PricingViewer is the pricing role — load
 * context, calculate costs/prices, view the trace (and later, write back to C4C). A bare
 * authenticated user with neither role gets 403. PricingAdmin holds the PricingViewer scope
 * too (mocked bob locally; the XSUAA PricingAdmin role template references both scopes), so
 * requiring PricingViewer here covers both. Enforced here at the service level — UI hiding
 * is NOT security.
 */
@protocol: 'rest'
service PricingService {
  @requires: 'authenticated-user'
  action price(payload: Map) returns Map;

  @requires: 'authenticated-user'
  action fetchItemAttributes(payload: Map) returns Map;

  // C4C-compatible facade: the exact contract C4C's retrivePriceBI / getPricePoints ABSL
  // already speaks to the BI price service (see CLAUDE.md decision log 2026-11-24) — the
  // raw body IS the ABSL payload, not wrapped in `payload`. PricingViewer, same as price:
  // the WSO2 technical user gets the Viewer role collection.
  @requires: 'authenticated-user'
  action getCustomerPriceList(requestorId: String, customer: Map, item: array of Map) returns Map;

  @requires: 'authenticated-user'
  action getPricePoints(requestorId: String, originOfData: String, priceTypeCode: String, supplierMainCde: String, itemLongNumber: String, unitCode: String, currencyCode: String) returns Map;

  // Product type-ahead for the Add-item dialog: live C4C material search when a connection
  // exists, else the local recorded catalog for the region — the response's `source` says
  // which answered (C4C | LOCAL_CATALOG), never silently.
  @requires: 'authenticated-user'
  action searchC4cProducts(payload: Map) returns Map;

  // Product-master details for a set of parts (fills blank description/UoM after a quote
  // fetch or an import). Typed outcomes; supplier is deliberately NOT part of this — it
  // lives in the custom OriginOfData BO, pending its OData service name.
  @requires: 'authenticated-user'
  action fetchC4cProductDetails(payload: Map) returns Map;

  // Supplier (ID / external ID / name) and warehouse data (stock class, lead time) per line,
  // from C4C's custom OriginOfData object — the same lookup C4C's getSupplierInformation does.
  // Typed outcomes; ambiguity is reported per line, never guessed.
  @requires: 'authenticated-user'
  action fetchC4cOriginOfData(payload: Map) returns Map;

  // READ a C4C quote/opportunity header + items into the pricing grid (the "replace the
  // Products tab" direction). Typed outcomes: OK | C4C_NOT_CONFIGURED |
  // C4C_CREDENTIALS_MISSING | C4C_ERROR — never a faked item list.
  @requires: 'authenticated-user'
  action fetchC4cObject(payload: Map) returns Map;

  // Write the results of a pricing run back to the C4C host object (Phase 5). A Viewer
  // capability per the owner's role spec. QUOTE items get cost/landed cost/price/margin/
  // pricing type; OPPORTUNITY items get cost fields only (price is never written — enforced
  // in the adapter); both get the ExternallyPriced_SDK/PricedBy_SDK/PricedOn_SDK audit
  // fields on the header. ETag-guarded: a concurrent C4C change answers C4C_CONFLICT
  // ("Object changed in C4C, reload"), never a blind overwrite.
  @requires: 'authenticated-user'
  action writeBackToC4C(payload: Map) returns Map;

  // KIT / BOM explosion (generic, every region): the components of one or more kit headers, fetched from the ERP
  // behind each header's Origin of Data through API6 getKitComponents: the common endpoint (api6.kitEndpoint), or that OOD's individual one (api6.kitEndpoints).
  // Components come back with SAP-style item numbers (header 10 -> 11, 12, 13 ...). A typed status per kit
  // (OK | NOT_FOUND | FAILED | OOD_UNKNOWN) — never an invented component list.
  @requires: 'authenticated-user'
  action fetchKitComponents(payload: Map) returns Map;

  // Access model (owner decision 2026-11-27): every authenticated user is a Viewer by default — no per-user role
  // assignment for ~1200 users; only PricingAdmin is granted individually. The strict per-user PricingViewer
  // check is a switch (TSS_VIEWER_FOR_ALL=false) enforced in pricing-service.js, so it can be turned back on
  // without a code change.

  // Who am I + which of the two roles do I hold — the UI routes to the Viewer or Admin view
  // from this (app-c4c/'s Component.js). Deliberately open to any authenticated user: a user
  // with neither role still needs the answer to be told they have no access (the service-level
  // 403s above stay the actual enforcement — this endpoint only describes, it never grants).
  @requires: 'authenticated-user'
  function me() returns Map;
}
