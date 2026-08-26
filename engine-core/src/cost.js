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
 * itemSelection: optional explicit candidate id chosen by the user (recorded in trace by caller)
 *   — always wins when it matches a candidate.
 * accessSequence: optional ordered list of source systems (e.g. ["C4C","ERP","CCD","CCP"]) —
 *   region-config's `costAccessSequence`. Walked in order; the first system with a matching
 *   candidate wins. This is TSS's own cost-source resolution order, not SAP's condition
 *   technique — deliberately just an ordered fallback over `candidate.source.system`.
 * Falls back to `costFacts.default` (or the first candidate) if neither an explicit selection
 * nor the access sequence matches anything — same as before accessSequence existed.
 * Never picks silently around a MISSING/STALE — purpose gates that in the kernel, not here.
 */
function resolveCandidate(costFacts, itemSelection, accessSequence) {
  if (!costFacts || !Array.isArray(costFacts.candidates) || costFacts.candidates.length === 0) {
    return { chosen: null, reason: 'NO_CANDIDATES', matchedStep: null };
  }

  if (itemSelection) {
    const chosen = costFacts.candidates.find(c => c.source && c.source.key === itemSelection);
    if (chosen) return { chosen, reason: null, matchedStep: null };
  }

  if (Array.isArray(accessSequence)) {
    for (const system of accessSequence) {
      const chosen = costFacts.candidates.find(c => c.source && c.source.system === system);
      if (chosen) return { chosen, reason: null, matchedStep: system };
    }
  }

  const wantId = itemSelection || costFacts.default;
  const chosen = costFacts.candidates.find(c => c.source && c.source.key === wantId) || costFacts.candidates[0];
  return { chosen, reason: null, matchedStep: null };
}

/**
 * Resolves region-config's `costAccessSequence` into the flat ordered list to use for THIS
 * item. Two supported shapes: a plain array (the original form — same order for every item,
 * unaffected by stock class) or an object keyed by canonical stock class ('MTS'|'NonMTS')
 * with an optional '*' entry as the default for anything else (e.g. Europe: Non-MTS parts'
 * cost is PIR data sourced from CCD first, everything else keeps the original C4C/ERP/CCD/CCP
 * order). Returns undefined if nothing applies, same as an absent costAccessSequence always has.
 */
function resolveAccessSequence(costAccessSequence, stockClass) {
  if (!costAccessSequence) return undefined;
  if (Array.isArray(costAccessSequence)) return costAccessSequence;
  return costAccessSequence[stockClass] || costAccessSequence['*'] || undefined;
}

/** Purpose gate per requirements §7: BINDING refuses FALLBACK/STALE/MISSING costs without explicit override. */
function purposeAllows(confidence, purpose, override) {
  if (confidence === CONFIDENCE.MISSING) return false;
  if (purpose === PURPOSE.BINDING && (confidence === CONFIDENCE.FALLBACK || confidence === CONFIDENCE.STALE)) {
    return !!override;
  }
  return true;
}

module.exports = { CONFIDENCE, BASIS, PURPOSE, resolveCandidate, resolveAccessSequence, purposeAllows };
