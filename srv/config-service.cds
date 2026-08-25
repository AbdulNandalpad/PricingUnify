/**
 * Config API. Thin REST surface over config-model's ConfigStore + AI-suggestion pipeline.
 * Read actions are open to any authenticated user; anything that can change a live config
 * (requesting an AI suggestion, approving, rejecting) requires the PricingAdmin role —
 * this is the "any approvedBy string is accepted, no role check" gap CLAUDE.md flags,
 * narrowed to at least requiring an authenticated PricingAdmin, not just any caller.
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
  function getEffectiveSupplierConfig(region: String, salesOrg: String, supplier: String, asOf: String) returns Map;

  @requires: 'PricingAdmin'
  action suggestChange(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action approveSuggestion(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action rejectSuggestion(payload: Map) returns Map;
}
