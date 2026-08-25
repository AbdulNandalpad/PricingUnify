/** Cost typed record — never a bare number. See requirements §5.2.
 *  { value, currency, priceUnit, uom, basis, source:{system,table,field,key},
 *    validFrom, retrievedAt, confidence: EXACT|FALLBACK|STALE|MISSING }
 *  Resolution may return a candidate SET with default + selectionPolicy (Americas). */
const CONFIDENCE = Object.freeze({ EXACT:'EXACT', FALLBACK:'FALLBACK', STALE:'STALE', MISSING:'MISSING' });
const BASIS = Object.freeze({ STANDARD:'STANDARD', MOVING_AVG:'MOVING_AVG', WEIGHTED_AVG:'WEIGHTED_AVG',
  SUPPLIER_CATALOG:'SUPPLIER_CATALOG', LAST_PURCHASE:'LAST_PURCHASE', TRANSFER:'TRANSFER',
  MANUAL:'MANUAL', AI_DERIVED:'AI_DERIVED' });
module.exports = { CONFIDENCE, BASIS };
