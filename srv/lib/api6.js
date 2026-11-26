const { createApi6Client, basicAuth, noAuth } = require('@tss-pricing/api6-client');
const { store } = require('./store');
const environment = require('./environment');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Which gateway / which credentials is decided by TSS_ENVIRONMENT (see lib/environment.js): QUA has a built-in
// default URL, PROD (or any other) takes its URL from API6_BASE_URL_<ENV> / the Connections tab. Credentials are
// NEVER defaulted and never stored.

let cached = { key: null, client: null };

/** Basic auth from API6_USERNAME_<ENV> / API6_PASSWORD_<ENV> (unsuffixed names count for QUA only) — environment
 *  only, never config, never code. Without both, calls go unauthenticated (fine for recorded mode; a live call
 *  will be refused by the gateway and surface as a typed FAILED, not a throw). */
function credentialsConfigured() {
  return Boolean(environment.secretVar('API6_USERNAME') && environment.secretVar('API6_PASSWORD'));
}
function envAuth() {
  return credentialsConfigured()
    ? basicAuth({ username: environment.secretVar('API6_USERNAME'), password: environment.secretVar('API6_PASSWORD') })
    : noAuth();
}
/** The saved settings, minus anything saved for ANOTHER environment. */
function usable(conn) { return environment.honours(conn) ? ((conn && conn.api6) || {}) : {}; }
function effectiveBaseUrl(a) {
  return (a && a.baseUrl && String(a.baseUrl).trim()) || environment.urlVar('API6_BASE_URL') || environment.profile().api6BaseUrl || null;
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
  const a = usable(conn);
  const key = JSON.stringify([environment.name(), a, credentialsConfigured()]);
  if (cached.key !== key) {
    const mode = a.mode || environment.urlVar('API6_MODE') || 'recorded';
    const baseUrl = effectiveBaseUrl(a);
    // Live with no URL for THIS environment (e.g. PROD before API6_BASE_URL_PROD is set): every call answers a
    // typed FAILED that names the missing setting, never a crash and never another environment's gateway.
    const unset = mode === 'live' && !baseUrl;
    cached = {
      key,
      client: createApi6Client({
        mode,
        baseUrl: unset ? 'https://base-url-not-set.invalid' : baseUrl,
        ...(unset ? { fetchImpl: async () => { throw new Error(`The API6 base URL is not set for environment ${environment.name()} — set API6_BASE_URL_${environment.name()} or the Connections tab.`); } } : {}),
        auth: envAuth(),
        costSourceEndpoints: a.costSourceEndpoints || {},
        kitEndpoints: a.kitEndpoints || {},
        ...(a.kitEndpoint ? { kitEndpoint: a.kitEndpoint } : {}),
        ...(a.kitRequestorId ? { kitRequestorId: a.kitRequestorId } : {}),
        ...(a.priceListEndpoint ? { priceListEndpoint: a.priceListEndpoint } : {}),
        ...(a.biPriceListEndpoint ? { biPriceListEndpoint: a.biPriceListEndpoint } : {}),
        ...(a.requestMapping ? { requestMapping: a.requestMapping } : {}),
      }),
    };
  }
  return cached.client;
}

const api6 = {
  get baseUrl() { return effectiveBaseUrl(usable(store.getEffectiveConnectionConfig(todayIso()))); },
  get environment() { return environment.name(); },
  get credentialsConfigured() { return credentialsConfigured(); },
  get mode() { return current().mode; },
  get authType() { return current().authType; },
  get costSourceEndpoints() { return current().costSourceEndpoints; },
  get priceListEndpoint() { return current().priceListEndpoint; },
  get kitEndpoints() { return current().kitEndpoints; },
  get kitEndpoint() { return current().kitEndpoint; },
  get kitRequestorId() { return current().kitRequestorId; },
  get biPriceListEndpoint() { return current().biPriceListEndpoint; },
  getPricingFacts: (args) => current().getPricingFacts(args),
  fetchCostsBySequence: (args) => current().fetchCostsBySequence(args),
  fetchPriceListCost: (args) => current().fetchPriceListCost(args),
  fetchKitComponents: (args) => current().fetchKitComponents(args),
  fetchBiPriceList: (body) => current().fetchBiPriceList(body),
  fetchBiCosts: (body) => current().fetchBiCosts(body),
};

module.exports = { api6, DEFAULT_BASE_URL: environment.PROFILES.QUA.api6BaseUrl };
