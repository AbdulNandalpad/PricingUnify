const { store } = require('./store');

const HUMAN_PROVENANCE = { source: 'HUMAN', authoredBy: 'seed@tss.example', authoredAt: '2026-08-01T00:00:00Z' };

/**
 * Synthetic Europe-shaped region-wide default config, not real TSS rates — matches
 * engine-core's own test fixture and api6-client's recorded europe-default.json, so the
 * whole stack prices the same known numbers end to end. Real region configs land via a
 * real config-authoring flow once finance-verified rates exist.
 */
function seed() {
  seedRegionConfig();
  seedSupplierConfigs();
}

function seedRegionConfig() {
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
    // Normalizes this region's raw ERP stock-class codes into the two canonical buckets
    // buildUp `when` conditions can branch on — see srv/pricing-service.js's
    // applyStockClassNormalization and engine-core/src/kernel.js. Not yet consumed by any
    // buildUp element below (Europe's real (region x stockClass) landed-cost formulas are
    // still pending finance sign-off), so this is purely classification/audit for now — every
    // demo part still prices identically regardless of stock class.
    stockClassMap: { MTS: 'MTS', 'MTS-Z': 'MTS', 'MTS-2C': 'MTS', OMT: 'NonMTS', SMT: 'NonMTS', CMT: 'NonMTS', MTO: 'NonMTS', MTC: 'NonMTS' },
    buildUp: [
      { id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE },
      { id: 'SCM_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.047, provenance: HUMAN_PROVENANCE },
      { id: 'FREIGHT', type: 'ADDER', amountRef: 'freight', provenance: HUMAN_PROVENANCE },
      { id: 'DUTY', type: 'ADDER', amountRef: 'duty', provenance: HUMAN_PROVENANCE },
      { id: 'TARIFF', type: 'ADDER', amountRef: 'tariff', provenance: HUMAN_PROVENANCE },
      { id: 'PICK_CHARGE', type: 'PER_LINE', amountRef: 'pickCharge', provenance: HUMAN_PROVENANCE },
    ],
    constraints: [
      { id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv', provenance: HUMAN_PROVENANCE },
      { id: 'MOQ', type: 'CONSTRAINT', kind: 'MIN_QTY', minRef: 'moq', provenance: HUMAN_PROVENANCE },
    ],
    rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
    provenance: HUMAN_PROVENANCE,
  });
}

/**
 * Landed-cost adders/constraints that vary by supplier — independent of the cost access
 * sequence (which only picks WHICH cost candidate to use). A line only gets these when the
 * caller sets item.supplier; with no supplier given, pricing uses whatever API6 already put
 * in facts.elements (see api6-client/recorded/europe-default.json's tariff:"0", moq:"1"
 * defaults) — there's no need for a "*" wildcard supplier-config entry to fall back to.
 */
function seedSupplierConfigs() {
  if (store.listSupplierConfigVersions('EUROPE', '*', 'ACME').length > 0) return;
  store.saveSupplierConfig({
    region: 'EUROPE',
    salesOrg: '*',
    supplier: 'ACME',
    version: '2026.08.0',
    status: 'ACTIVE',
    validFrom: '2026-08-01',
    validTo: null,
    freight: '18.00',
    duty: '9.50',
    tariff: '12.00',
    molv: '300.00',
    moq: '25',
    provenance: HUMAN_PROVENANCE,
  });
}

module.exports = { seed };
