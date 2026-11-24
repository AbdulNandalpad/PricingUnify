const path = require('node:path');
const { createConnector } = require('./connector');
const authStrategies = require('./auth/strategies');
const { noAuth } = authStrategies;

/**
 * The single door to API6 (requirements §8): one call per pricing run, raw facts only —
 * API6 never pre-applies a markup, so everything this returns is exactly what engine-core's
 * `facts` argument expects. Defaults to recorded-payload mode (API6_MODE unset or
 * "recorded") — no live credentials are required until the app is actually pointed at a
 * real API6 endpoint (API6_MODE=live, API6_BASE_URL, and an auth strategy).
 */
/** WSO2/API6 endpoint per cost-source system — the configured cost access sequence drives
 *  WHICH of these get called and in what order (owner decision 2026-11-24: "the routing
 *  should happen based on the sequence defined... call different endpoints in WSO2").
 *  Integration config, overridable per deployment; an unlisted system falls back to
 *  `/costs/<system lowercased>`. Never pricing config — the sequence itself stays in
 *  region-config where it always was. */
const DEFAULT_COST_SOURCE_ENDPOINTS = {
  C4C: '/costs/c4c',
  ERP: '/costs/erp',
  CCD: '/costs/ccd',
  CCP: '/costs/ccp',
};
const DEFAULT_PRICE_LIST_ENDPOINT = '/costs/price-list';

function createApi6Client({
  mode = process.env.API6_MODE || 'recorded',
  baseUrl = process.env.API6_BASE_URL,
  auth = noAuth(),
  recordedDir = path.join(__dirname, '..', 'recorded'),
  costSourceEndpoints = {},
  priceListEndpoint = DEFAULT_PRICE_LIST_ENDPOINT,
} = {}) {
  const connector = createConnector({ mode, baseUrl, authStrategy: auth, recordedDir });
  const endpoints = { ...DEFAULT_COST_SOURCE_ENDPOINTS, ...costSourceEndpoints };
  const endpointFor = (system) => endpoints[system] || `/costs/${String(system).toLowerCase()}`;

  return {
    mode: connector.mode,
    authType: connector.authType,

    /** Returns { costs, elements, fx } shaped exactly like engine-core's `facts` — quantity
     *  breaks are the engine's problem (requirements §8), so `items` here is only used to
     *  pick/validate the recorded scenario, never to vary the call itself. */
    async getPricingFacts({ region, salesOrg, items, scenario }) {
      const recordedScenario = scenario || `${region.toLowerCase()}-default`;
      return connector.call(recordedScenario, {
        method: 'POST',
        path: '/pricing-facts',
        body: { region, salesOrg, items },
      });
    },

    /**
     * Walks the given cost access sequence, calling each source system's own WSO2 endpoint in
     * order, and stops at the first system that returns a cost candidate. Returns
     * { candidates, routing } where routing records every call made ({system, endpoint,
     * found}) so the trace can show the walk — never a silent fallback. In recorded mode each
     * "endpoint call" is simulated faithfully by filtering the region scenario's candidates to
     * that one system (exactly what the per-source endpoint would return); in live mode each
     * system is a real HTTP call to its configured endpoint.
     */
    async fetchCostsBySequence({ region, salesOrg, partNumber, quantity, sequence, scenario }) {
      const recordedScenario = scenario || `${region.toLowerCase()}-default`;
      const routing = [];
      const candidates = [];
      for (const system of sequence) {
        const endpoint = endpointFor(system);
        let sourceCandidates;
        if (connector.mode === 'recorded') {
          const payload = await connector.call(recordedScenario);
          const all = (payload.costs && payload.costs[partNumber] && payload.costs[partNumber].candidates) || [];
          sourceCandidates = all.filter((c) => c.source && c.source.system === system);
        } else {
          const res = await connector.call(recordedScenario, {
            method: 'POST',
            path: endpoint,
            body: { region, salesOrg, partNumber, quantity },
          });
          sourceCandidates = (res && res.candidates) || [];
        }
        routing.push({ system, endpoint, found: sourceCandidates.length });
        candidates.push(...sourceCandidates);
        if (sourceCandidates.length > 0) break;
      }
      return { candidates, routing };
    },

    /**
     * PRICE_LIST pricing type's cost lookup (owner decision 2026-11-24): a price list in TSS
     * carries COSTS, keyed by supplier first, else by product category — the normal build-up
     * (markup etc.) still applies on top afterward. Returns { entry, matchedBy, endpoint,
     * tried }: `entry` is the matching qty-break tier (or null), `matchedBy` says which key
     * won ('SUPPLIER:<id>' | 'CATEGORY:<id>'), `tried` lists every key attempted so a miss is
     * fully explained. In recorded mode the lookup reads the region scenario's `priceLists`
     * section (simulating what the WSO2 price-list endpoint returns for the given key, qty
     * and date); in live mode it is one call to the configured price-list endpoint.
     */
    async fetchPriceListCost({ region, salesOrg, partNumber, supplier, productCategory, quantity, priceDate, scenario }) {
      if (connector.mode !== 'recorded') {
        const res = await connector.call(null, {
          method: 'POST',
          path: priceListEndpoint,
          body: { region, salesOrg, partNumber, supplier, productCategory, quantity, priceDate },
        });
        return { endpoint: priceListEndpoint, ...res };
      }

      const payload = await connector.call(scenario || `${region.toLowerCase()}-default`);
      const lists = payload.priceLists || {};
      const lookups = [];
      if (supplier) lookups.push({ matchedBy: `SUPPLIER:${supplier}`, table: lists.bySupplier && lists.bySupplier[supplier] });
      if (productCategory) lookups.push({ matchedBy: `CATEGORY:${productCategory}`, table: lists.byCategory && lists.byCategory[productCategory] });

      const tried = [];
      const qty = Number(quantity);
      for (const { matchedBy, table } of lookups) {
        tried.push(matchedBy);
        const entries = (table && table[partNumber]) || [];
        const effective = entries.filter(
          (e) => (!e.validFrom || !priceDate || e.validFrom <= priceDate) && (!e.validTo || !priceDate || priceDate <= e.validTo),
        );
        const tier = effective
          .filter((e) => Number(e.minQty) <= qty)
          .sort((a, b) => Number(b.minQty) - Number(a.minQty))[0];
        if (tier) return { entry: tier, matchedBy, endpoint: priceListEndpoint, tried };
      }
      return { entry: null, matchedBy: null, endpoint: priceListEndpoint, tried };
    },
  };
}

module.exports = { createApi6Client, createConnector, ...authStrategies };
