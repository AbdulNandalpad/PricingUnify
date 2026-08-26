/**
 * Config API. Thin REST surface over config-model's ConfigStore + AI-suggestion pipeline.
 * Read actions are open to any authenticated user; anything that can change a live config —
 * a direct human edit (saveRegionConfig/saveSupplierConfig/saveRegionRoute/savePartyConfig)
 * or the AI-suggestion pipeline (requesting, approving, rejecting) — requires the
 * PricingAdmin role. A direct save always creates a brand-new version (config is never
 * mutated in place, per the versioning non-negotiable); provenance is always stamped
 * HUMAN/the calling user server-side, never trusted from the payload.
 */
@protocol: 'rest'
service ConfigService {
  @requires: 'authenticated-user'
  function getEffectiveConfig(region: String, salesOrg: String, asOf: String) returns Map;

  @requires: 'authenticated-user'
  function listVersions(region: String, salesOrg: String) returns Map;

  @requires: 'authenticated-user'
  function listSuggestions(region: String, status: String) returns Map;

  @requires: 'authenticated-user'
  function getEffectiveSupplierConfig(supplier: String, asOf: String) returns Map;

  @requires: 'authenticated-user'
  function listSuppliers(asOf: String) returns Map;

  @requires: 'authenticated-user'
  function getEffectiveRegionRoute(ood: String, salesOrg: String, asOf: String) returns Map;

  @requires: 'authenticated-user'
  function listRegionRouteVersions(ood: String, salesOrg: String) returns Map;

  @requires: 'authenticated-user'
  function getEffectivePartyConfig(customerId: String, asOf: String) returns Map;

  @requires: 'authenticated-user'
  function listPartyConfigVersions(customerId: String) returns Map;

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
