/** Cost typed record — never a bare number. See requirements §5.2.
 *  { value, currency, priceUnit, uom, basis, source:{system,table,field,key},
 *    validFrom, retrievedAt, confidence: EXACT|FALLBACK|STALE|MISSING }
 *  Resolution may return a candidate SET with default + selectionPolicy (Americas). */
const CONFIDENCE = Object.freeze({ EXACT:'EXACT', FALLBACK:'FALLBACK', STALE:'STALE', MISSING:'MISSING' });
const BASIS = Object.freeze({ STANDARD:'STANDARD', MOVING_AVG:'MOVING_AVG', WEIGHTED_AVG:'WEIGHTED_AVG',
  SUPPLIER_CATALOG:'SUPPLIER_CATALOG', LAST_PURCHASE:'LAST_PURCHASE', TRANSFER:'TRANSFER',
  MANUAL:'MANUAL', AI_DERIVED:'AI_DERIVED' });

const PURPOSE = Object.freeze({ INDICATIVE:'INDICATIVE', BINDING:'BINDING', REPRICE:'REPRICE', SIMULATION:'SIMULATION' });

/**
 * Resolves a cost candidate set to the one this pricing run uses.
 * costFacts: { candidates: Cost[], default: string } — `default` is a candidate id (source.key).
 * itemSelection: optional explicit candidate id chosen by the user (recorded in trace by caller).
 * Never picks silently around a MISSING/STALE — purpose gates that in the kernel, not here.
 */
function resolveCandidate(costFacts, itemSelection) {
  if (!costFacts || !Array.isArray(costFacts.candidates) || costFacts.candidates.length === 0) {
    return { chosen: null, reason: 'NO_CANDIDATES' };
  }
  const wantId = itemSelection || costFacts.default;
  const chosen = costFacts.candidates.find(c => c.source && c.source.key === wantId) || costFacts.candidates[0];
  return { chosen, reason: null };
}

/** Purpose gate per requirements §7: BINDING refuses FALLBACK/STALE/MISSING costs without explicit override. */
function purposeAllows(confidence, purpose, override) {
  if (confidence === CONFIDENCE.MISSING) return false;
  if (purpose === PURPOSE.BINDING && (confidence === CONFIDENCE.FALLBACK || confidence === CONFIDENCE.STALE)) {
    return !!override;
  }
  return true;
}

module.exports = { CONFIDENCE, BASIS, PURPOSE, resolveCandidate, purposeAllows };
