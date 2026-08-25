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
function createApi6Client({
  mode = process.env.API6_MODE || 'recorded',
  baseUrl = process.env.API6_BASE_URL,
  auth = noAuth(),
  recordedDir = path.join(__dirname, '..', 'recorded'),
} = {}) {
  const connector = createConnector({ mode, baseUrl, authStrategy: auth, recordedDir });

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
  };
}

module.exports = { createApi6Client, createConnector, ...authStrategies };
