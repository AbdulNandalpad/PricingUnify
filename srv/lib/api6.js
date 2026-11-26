const { createApi6Client, basicAuth, noAuth } = require('@tss-pricing/api6-client');
const { store } = require('./store');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// The TSS API6 QUA gateway (APIM). A URL is a tenant fact, not a secret, so it is a default;
// override in the Connections tab or with API6_BASE_URL. Credentials are NEVER defaulted.
const DEFAULT_BASE_URL = 'https://apimqua.tss.trelleborg.com';

let cached = { key: null, client: null };

/** Basic auth from API6_USERNAME / API6_PASSWORD (environment only — never config, never code).
 *  Without both, calls go unauthenticated (fine for recorded mode; a live call will be refused
 *  by the gateway and surface as a typed FAILED, not a throw). */
function credentialsConfigured() {
  return Boolean(process.env.API6_USERNAME && process.env.API6_PASSWORD);
}
function envAuth() {
  return credentialsConfigured()
    ? basicAuth({ username: process.env.API6_USERNAME, password: process.env.API6_PASSWORD })
    : noAuth();
}
function effectiveBaseUrl(a) {
  return (a && a.baseUrl && String(a.baseUrl).trim()) || process.env.API6_BASE_URL || DEFAULT_BASE_URL;
}

/**
 * The API6/WSO2 client, honoring the admin-maintained connection-config (owner decision
 * 2026-11-24: these are EXTERNAL endpoints, not BTP-managed, so they are editable in the
 * admin UI). Precedence: UI-saved connection-config > environment defaults > recorded mode.
 * Credentials never come from config — auth strategy stays environment/deployment-owned.
 * The client is rebuilt only when the effective connection settings actually change, so a
 * save in the admin UI takes effect on the very next call, no restart.
 */
function current() {
  const conn = store.getEffectiveConnectionConfig(todayIso());
  const a = (conn && conn.api6) || {};
  const key = JSON.stringify(a);
  if (cached.key !== key) {
    cached = {
      key,
      client: createApi6Client({
        mode: a.mode || process.env.API6_MODE || 'recorded',
        baseUrl: effectiveBaseUrl(a),
        auth: envAuth(),
        costSourceEndpoints: a.costSourceEndpoints || {},
        kitEndpoints: a.kitEndpoints || {},
        ...(a.priceListEndpoint ? { priceListEndpoint: a.priceListEndpoint } : {}),
        ...(a.biPriceListEndpoint ? { biPriceListEndpoint: a.biPriceListEndpoint } : {}),
        ...(a.requestMapping ? { requestMapping: a.requestMapping } : {}),
      }),
    };
  }
  return cached.client;
}

const api6 = {
  get baseUrl() { return effectiveBaseUrl((store.getEffectiveConnectionConfig(todayIso()) || {}).api6); },
  get credentialsConfigured() { return credentialsConfigured(); },
  get mode() { return current().mode; },
  get authType() { return current().authType; },
  get costSourceEndpoints() { return current().costSourceEndpoints; },
  get priceListEndpoint() { return current().priceListEndpoint; },
  get kitEndpoints() { return current().kitEndpoints; },
  get biPriceListEndpoint() { return current().biPriceListEndpoint; },
  getPricingFacts: (args) => current().getPricingFacts(args),
  fetchCostsBySequence: (args) => current().fetchCostsBySequence(args),
  fetchPriceListCost: (args) => current().fetchPriceListCost(args),
  fetchKitComponents: (args) => current().fetchKitComponents(args),
  fetchBiPriceList: (body) => current().fetchBiPriceList(body),
  fetchBiCosts: (body) => current().fetchBiCosts(body),
};

module.exports = { api6, DEFAULT_BASE_URL };
