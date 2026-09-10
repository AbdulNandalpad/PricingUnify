/**
 * TSS Pricing Engine — Kernel entry point.
 * RULES (see /CLAUDE.md, /docs/PRICING_ENGINE_REQUIREMENTS.md, /docs/ARCHITECTURE_V2.md):
 *  - Pure function: all facts arrive in the request; NO I/O here.
 *  - Decimal math only (decimal.js). Never float.
 *  - Every FACTOR must declare `basis` — refuse to run otherwise.
 *  - null !== 0. MISSING is a typed outcome, never a thrown exception.
 *  - Every result carries a full trace.
 *  - Three techniques, one result shape: priceItems() routes each line to cost plus,
 *    price list, or catalog + formula.
 */
const { price } = require('./kernel');
const { priceItems, flagsFor } = require('./priceItems');
const { CONFIDENCE, BASIS, PURPOSE } = require('./cost');
const { ELEMENT_TYPES } = require('./elements');
const { TECHNIQUES, resolveTechnique } = require('./routing');
const { resolveRows, tierValue, specificity, describeMatch } = require('./rules');
const formula = require('./formula');
const { roundTo } = require('./rounding');

module.exports = {
  price,
  priceItems,
  flagsFor,
  CONFIDENCE,
  BASIS,
  PURPOSE,
  ELEMENT_TYPES,
  TECHNIQUES,
  resolveTechnique,
  resolveRows,
  tierValue,
  specificity,
  describeMatch,
  roundTo,
  formula,
  DSL_VERSION: formula.DSL_VERSION,
  parseFormula: formula.parse,
  evaluateFormula: formula.evaluateFormula,
  validateFormula: formula.validateFormula,
};
