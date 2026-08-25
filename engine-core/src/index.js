/**
 * TSS Pricing Engine — Kernel entry point.
 * RULES (see /CLAUDE.md and /docs/PRICING_ENGINE_REQUIREMENTS.md):
 *  - Pure function: all facts arrive in the request; NO I/O here.
 *  - Decimal math only (decimal.js). Never float.
 *  - Every FACTOR must declare `basis` — refuse to run otherwise.
 *  - null !== 0. MISSING is a typed outcome, never a thrown exception.
 *  - Every result carries a full trace.
 */
const { price } = require('./kernel');
module.exports = { price };
