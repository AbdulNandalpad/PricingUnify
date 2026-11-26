'use strict';

/**
 * Environment for a server a TEST spawns. Starts from the developer's shell (PATH etc. are needed)
 * but removes everything that points the backend at real systems or changes its behaviour —
 * API6/C4C endpoints and credentials, the AI key, live mode, production profile — so `npm test`
 * can never reach a real gateway or tenant, whatever the developer exported (the decision log
 * tells them to `export API6_MODE=live`).
 */
const STRIP = /^(API6_|C4C_|ANTHROPIC_|PRICING_|NODE_ENV$|CDS_|VCAP_|destinations$|TSS_)/;

function hermeticEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  return { ...env, API6_MODE: 'recorded', ...extra };
}

module.exports = { hermeticEnv };
