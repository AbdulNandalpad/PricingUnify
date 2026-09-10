using from './db/schema';

/**
 * Pricing API (ARCHITECTURE_V2 §4.3). CAP is only the host — see pricing-service.js. It
 * resolves the effective region config, price lists, catalogs and routing rules as-of the
 * price date from config-model, resolves facts from API6 (recorded payloads in dev), and
 * hands all of it to engine-core's priceItems() unchanged. No pricing logic lives here.
 *
 * Every endpoint requires an authenticated user AND a real user principal — see
 * srv/lib/principal.js (403 NO_USER_PRINCIPAL for anonymous/privileged/client-credentials).
 */
@protocol: 'rest'
service PricingService {
  @requires: 'authenticated-user'
  action price(payload: Map) returns Map;

  @requires: 'authenticated-user'
  action fetchItemAttributes(payload: Map) returns Map;

  @requires: 'authenticated-user'
  action simulate(payload: Map) returns Map;

  @requires: 'authenticated-user'
  function getPricingDocument(id: String) returns Map;

  @requires: 'authenticated-user'
  function listPricingDocuments(hostObjectId: String, from: String, to: String, limit: Integer) returns Map;

  @requires: 'authenticated-user'
  function whoami() returns Map;
}
