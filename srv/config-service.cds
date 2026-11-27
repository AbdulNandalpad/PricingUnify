/**
 * Config API. Thin REST surface over config-model's ConfigStore + AI-suggestion pipeline.
 * The ENTIRE service — reads included — requires PricingAdmin (Phase 2, owner spec
 * 2026-11-24: a PricingViewer sees only the pricing view; no config endpoint is reachable
 * for them, 403). Writes (direct saves and the AI-suggestion pipeline) were always
 * PricingAdmin. A direct save always creates a brand-new version (config is never mutated
 * in place, per the versioning non-negotiable); provenance is always stamped HUMAN/the
 * calling user server-side, never trusted from the payload. Enforced here at the service
 * level — UI hiding is NOT security.
 */
@protocol: 'rest'
service ConfigService {
  @requires: 'PricingAdmin'
  function getEffectiveConfig(region: String, salesOrg: String, asOf: String) returns Map;

  @requires: 'PricingAdmin'
  function listVersions(region: String, salesOrg: String) returns Map;

  @requires: 'PricingAdmin'
  function listSuggestions(region: String, status: String) returns Map;

  @requires: 'PricingAdmin'
  function getEffectiveSupplierConfig(supplier: String, asOf: String) returns Map;

  @requires: 'PricingAdmin'
  function listSuppliers(asOf: String) returns Map;

  @requires: 'PricingAdmin'
  function listSupplierConfigVersions(supplier: String) returns Map;

  @requires: 'PricingAdmin'
  function getEffectiveRegionRoute(ood: String, salesOrg: String, asOf: String) returns Map;

  @requires: 'PricingAdmin'
  function listRegionRouteVersions(ood: String, salesOrg: String) returns Map;

  @requires: 'PricingAdmin'
  function getEffectivePartyConfig(customerId: String, asOf: String) returns Map;

  @requires: 'PricingAdmin'
  function listPartyConfigVersions(customerId: String) returns Map;

  // Integration connections: which API6/WSO2 endpoints and C4C service path this deployment
  // talks to. EDITABLE (owner decision 2026-11-24 — these are external endpoints, not
  // BTP-managed): saves create a versioned connection-config document. Credentials are
  // never part of it — they stay in environment secrets / the BTP destination.
  @requires: 'PricingAdmin'
  function getConnections() returns Map;

  // Every config document (all versions) as JSON, for promoting a config to another environment through
  // the repo (config/<kind>.json). Pricing rules are code; this is how QUA edits reach PROD.
  @requires: 'PricingAdmin'
  function exportConfig() returns Map;

  @requires: 'PricingAdmin'
  action saveConnections(payload: Map) returns Map;

  // Read-only browser over what the WSO2 price-list endpoint serves (owner decision
  // 2026-11-24: price lists are maintained at the source, not in our config store — this
  // tab looks, it never writes).
  @requires: 'PricingAdmin'
  function lookupPriceList(region: String, supplier: String, productCategory: String, partNumber: String, quantity: Double, asOf: String) returns Map;

  @requires: 'PricingAdmin'
  action saveRegionConfig(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action saveSupplierConfig(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action saveRegionRoute(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action savePartyConfig(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action suggestChange(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action approveSuggestion(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action rejectSuggestion(payload: Map) returns Map;
}
