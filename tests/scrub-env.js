'use strict';
/**
 * Preloaded into EVERY test process (`node --test --require ../tests/scrub-env.js`): removes whatever
 * in the developer's shell points the code at real systems or changes its behaviour — API6/C4C
 * endpoints and credentials, the AI key, live mode, the production profile — and pins recorded mode.
 * `npm test` must give the same answer on any machine and must never reach a real gateway or tenant.
 */
const STRIP = /^(API6_|C4C_|ANTHROPIC_|PRICING_|NODE_ENV$|CDS_|VCAP_|destinations$|TSS_)/;
for (const key of Object.keys(process.env)) if (STRIP.test(key)) delete process.env[key];
process.env.API6_MODE = 'recorded';
