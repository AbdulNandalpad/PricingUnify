const { store } = require('./store');

const HUMAN_PROVENANCE = { source: 'HUMAN', authoredBy: 'seed@tss.example', authoredAt: '2026-08-01T00:00:00Z' };

/**
 * Synthetic Europe-shaped region-wide default config, not real TSS rates — matches
 * engine-core's own test fixture and api6-client's recorded europe-default.json, so the
 * whole stack prices the same known numbers end to end. Real region configs land via a
 * real config-authoring flow once finance-verified rates exist.
 */
function seed() {
  if (store.listVersions('EUROPE', '*').length > 0) return; // idempotent — safe to call more than once
  store.saveVersion({
    region: 'EUROPE',
    salesOrg: '*',
    version: '2026.08.0',
    status: 'ACTIVE',
    supersedes: null,
    validFrom: '2026-08-01',
    validTo: null,
    resolution: [{ id: 'RES_MOVING_AVG', stockClass: 'MTS', costBasis: 'MOVING_AVG', provenance: HUMAN_PROVENANCE }],
    costAccessSequence: ['C4C', 'ERP', 'CCD', 'CCP'],
    buildUp: [
      { id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE },
      { id: 'SCM_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.047, provenance: HUMAN_PROVENANCE },
      { id: 'FREIGHT', type: 'ADDER', amountRef: 'freight', provenance: HUMAN_PROVENANCE },
      { id: 'DUTY', type: 'ADDER', amountRef: 'duty', provenance: HUMAN_PROVENANCE },
      { id: 'PICK_CHARGE', type: 'PER_LINE', amountRef: 'pickCharge', provenance: HUMAN_PROVENANCE },
    ],
    constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv', provenance: HUMAN_PROVENANCE }],
    rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
    provenance: HUMAN_PROVENANCE,
  });
}

module.exports = { seed };
