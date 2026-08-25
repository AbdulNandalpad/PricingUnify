/** Trace builder — every priced result explains itself: each step, rates + basis,
 *  cost candidate chosen (and by whom), provenance, config version IDs, constraint passes.
 *  No wall-clock or random data is generated here — determinism (§5.3) requires every
 *  value in the trace to trace back to the input (facts/config), never to "now". */

function step(id, type, { delta, runningTotal, note, missing } = {}) {
  return {
    id,
    type,
    delta: delta === undefined || delta === null ? null : delta.toString(),
    runningTotal: runningTotal === undefined || runningTotal === null ? null : runningTotal.toString(),
    note: note || null,
    missing: missing || null,
  };
}

function costCandidateEntry(cost, selectedBy) {
  if (!cost) return null;
  return {
    value: cost.value != null ? String(cost.value) : null,
    currency: cost.currency,
    basis: cost.basis,
    confidence: cost.confidence,
    source: cost.source,
    validFrom: cost.validFrom,
    retrievedAt: cost.retrievedAt,
    selectedBy: selectedBy || 'DEFAULT',
  };
}

function build({ region, configVersion, costCandidate, selectedBy, steps, constraintPasses, stockClass }) {
  return {
    region,
    configVersion,
    costCandidate: costCandidateEntry(costCandidate, selectedBy),
    stockClass: stockClass || null,
    steps,
    constraintPasses: constraintPasses || [],
  };
}

module.exports = { step, costCandidateEntry, build };
