/**
 * Pricing API. CAP is only the host — see pricing-service.js. It resolves the effective
 * (region, salesOrg) config from config-model, resolves facts from API6 (recorded payloads
 * in dev), and hands both to engine-core's price() unchanged. No pricing logic lives here.
 */
@protocol: 'rest'
service PricingService {
  @requires: 'authenticated-user'
  action price(payload: Map) returns Map;
}
