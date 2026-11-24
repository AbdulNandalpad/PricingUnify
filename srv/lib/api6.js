const { createApi6Client } = require('@tss-pricing/api6-client');
const { store } = require('./store');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

let cached = { key: null, client: null };

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
        baseUrl: (a.baseUrl && String(a.baseUrl).trim()) || process.env.API6_BASE_URL,
        costSourceEndpoints: a.costSourceEndpoints || {},
        ...(a.priceListEndpoint ? { priceListEndpoint: a.priceListEndpoint } : {}),
        ...(a.biPriceListEndpoint ? { biPriceListEndpoint: a.biPriceListEndpoint } : {}),
        ...(a.requestMapping ? { requestMapping: a.requestMapping } : {}),
      }),
    };
  }
  return cached.client;
}

const api6 = {
  get mode() { return current().mode; },
  get authType() { return current().authType; },
  get costSourceEndpoints() { return current().costSourceEndpoints; },
  get priceListEndpoint() { return current().priceListEndpoint; },
  get biPriceListEndpoint() { return current().biPriceListEndpoint; },
  getPricingFacts: (args) => current().getPricingFacts(args),
  fetchCostsBySequence: (args) => current().fetchCostsBySequence(args),
  fetchPriceListCost: (args) => current().fetchPriceListCost(args),
  fetchBiPriceList: (body) => current().fetchBiPriceList(body),
  fetchBiCosts: (body) => current().fetchBiCosts(body),
};

module.exports = { api6 };
