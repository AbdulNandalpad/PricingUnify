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
  @requires: 'PricingViewer'
  action price(payload: Map) returns Map;

  @requires: 'PricingViewer'
  action fetchItemAttributes(payload: Map) returns Map;

  // Who am I + which of the two roles do I hold — the UI routes to the Viewer or Admin view
  // from this (app-c4c/'s Component.js). Deliberately open to any authenticated user: a user
  // with neither role still needs the answer to be told they have no access (the service-level
  // 403s above stay the actual enforcement — this endpoint only describes, it never grants).
  @requires: 'authenticated-user'
  function me() returns Map;
}
