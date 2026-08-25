const { createApi6Client } = require('@tss-pricing/api6-client');

/**
 * Defaults to recorded-payload mode — no live API6 endpoint or credentials required.
 * Switching to the real thing later is a config change (API6_MODE=live, API6_BASE_URL,
 * and an auth strategy — see api6-client/README.md), not a code change.
 */
const api6 = createApi6Client();

module.exports = { api6 };
