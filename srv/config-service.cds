using from './db/schema';

/**
 * Config API (ARCHITECTURE_V2 §4.3): one generic surface over config-model's ConfigStore
 * for every document kind (region-config, supplier-config, region-route, party-config,
 * price-list, catalog-book, routing-rules) plus the AI-suggestion pipeline. Reads are open
 * to any authenticated user; anything that creates or changes a document (drafts, publish,
 * discard, direct ACTIVE saves, AI suggestions) requires PricingAdmin. Provenance
 * (authoredBy / publishedBy / reviewedBy) is always the token's user id, stamped
 * server-side — never trusted from a payload.
 *
 * The pre-v2 names (getEffectiveConfig, saveRegionConfig, ...) remain as thin aliases so
 * existing callers keep working until they are rewritten.
 */
@protocol: 'rest'
service ConfigService {
  // ---- generic reads ----------------------------------------------------------------
  @requires: 'authenticated-user'
  function getEffective(kind: String, key: String, asOf: String) returns Map;

  @requires: 'authenticated-user'
  function listVersions(kind: String, key: String, region: String, salesOrg: String) returns Map;

  @requires: 'authenticated-user'
  function getVersion(kind: String, key: String, version: String) returns Map;

  @requires: 'authenticated-user'
  function diff(kind: String, key: String, a: String, b: String) returns Map;

  @requires: 'authenticated-user'
  function listBooks(kind: String, asOf: String) returns Map;

  @requires: 'authenticated-user'
  function listKeys(kind: String) returns Map;

  @requires: 'authenticated-user'
  function listDrafts(kind: String) returns Map;

  @requires: 'authenticated-user'
  function listSuppliers(asOf: String) returns Map;

  @requires: 'authenticated-user'
  function validateFormula(formula: String, kind: String, key: String, version: String) returns Map;

  // ---- generic writes (PricingAdmin) --------------------------------------------------
  @requires: 'PricingAdmin'
  action saveDraft(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action publish(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action discardDraft(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action saveActive(payload: Map) returns Map;

  // ---- AI suggestions (any document kind) ---------------------------------------------
  @requires: 'authenticated-user'
  function listSuggestions(status: String, targetKind: String, targetKey: String, region: String) returns Map;

  @requires: 'PricingAdmin'
  action suggestChange(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action approveSuggestion(payload: Map) returns Map;

  @requires: 'PricingAdmin'
  action rejectSuggestion(payload: Map) returns Map;

  // ---- legacy aliases (pre-v2 names) -----------------------------------------------------
  @requires: 'authenticated-user'
  function getEffectiveConfig(region: String, salesOrg: String, asOf: String) returns Map;

  @requires: 'authenticated-user'
  function getEffectiveSupplierConfig(supplier: String, asOf: String) returns Map;

  @requires: 'authenticated-user'
  function listSupplierConfigVersions(supplier: String) returns Map;

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
}
