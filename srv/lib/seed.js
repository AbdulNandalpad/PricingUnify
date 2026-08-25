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
  seedChinaRegionConfig();
  seedIndiaRegionConfig();
  seedAmericasRegionConfig();
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
    // applyStockClassNormalization and engine-core/src/kernel.js.
    stockClassMap: { MTS: 'MTS', 'MTS-Z': 'MTS', 'MTS-2C': 'MTS', OMT: 'NonMTS', SMT: 'NonMTS', CMT: 'NonMTS', MTO: 'NonMTS', MTC: 'NonMTS' },
    // Topic 4 (Appendix A): Europe's real formula splits by stock class — Non-MTS gets
    // freight+duty on top of the base cost, MTS does not (moving-average cost is already
    // "clean"). SCM markup and pick apply to both classes either way.
    buildUp: [
      { id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE },
      { id: 'SCM_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.047, provenance: HUMAN_PROVENANCE },
      { id: 'FREIGHT', type: 'ADDER', amountRef: 'freight', when: "item.stockClass === 'NonMTS'", provenance: HUMAN_PROVENANCE },
      { id: 'DUTY', type: 'ADDER', amountRef: 'duty', when: "item.stockClass === 'NonMTS'", provenance: HUMAN_PROVENANCE },
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
 * China's real cost-route logic (topic 3 of the reference-doc review): which multiplier
 * stack applies is a genuine 3-way branch on origin of data, supplier, and COO — not a
 * generic per-region markup. Per the owner's stakeholder-corrected reference doc: "OOD needs
 * to be considered in the logic, and NOT the Supplier Country."
 *   - OOD is JDE China ("CN"): the cost JDE China returns is already landed (freight+duty
 *     baked in) — only the 3.2% LCS markup applies.
 *   - OOD is not JDE China, sourced directly from an actual supplier (not 88058/LCE):
 *     freight&duty by COO (US ×1.32, non-US ×1.21 — a COMPOSITE factor per requirements
 *     §5.1, since the real data is one blended rate, not separate freight/duty percentages),
 *     then the 3.2% LCS markup on top.
 *   - OOD is not JDE China, sourced via LCE/SAP Europe (supplier "88058"): same freight&duty
 *     + LCS markup chain, plus a further 6% LCE markup.
 * Real China Pick cost is documented as always 0, so no PER_LINE element at all; no MOLV/MOQ
 * constraints yet either (those are the supplier-config mechanism's job, and no CHINA
 * supplier-config exists yet).
 *
 * Topic 4 (Appendix A) update: Appendix A's compressed summary claims MTS items never get
 * freight&duty, but the detailed UC examples (topic 3) clearly show MTS items sourced via the
 * SAP Europe/LCE route DO get it — only OOD determines that, not stock class (confirmed with
 * the owner). So stock class turns out NOT to change China's build-up structure at all; the
 * real distinction Appendix A is pointing at is the BASE cost's *source* (moving average vs
 * catalog/step price), which API6 already resolves before facts reach us (topic 2's
 * decision). stockClassMap is declared anyway, purely for classification/audit visibility —
 * same as Europe's originally was before any element consumed it.
 */
function seedChinaRegionConfig() {
  if (store.listVersions('CHINA', '*').length > 0) return;
  store.saveVersion({
    region: 'CHINA',
    salesOrg: '*',
    version: '2026.08.0',
    status: 'ACTIVE',
    supersedes: null,
    validFrom: '2026-08-01',
    validTo: null,
    resolution: [
      { id: 'RES_JDE_CHINA', originOfData: 'CN', costBasis: 'MOVING_AVG', provenance: HUMAN_PROVENANCE },
      { id: 'RES_SAP_EUROPE_FALLBACK', originOfData: 'SAP', fallback: ['RES_JDE_CHINA'], costBasis: 'SUPPLIER_CATALOG', provenance: HUMAN_PROVENANCE },
    ],
    stockClassMap: { MTS: 'MTS', 'MTS-Z': 'MTS', 'MTS-2C': 'MTS', OMT: 'NonMTS', SMT: 'NonMTS', CMT: 'NonMTS', MTO: 'NonMTS', MTC: 'NonMTS' },
    buildUp: [
      { id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE },
      { id: 'ROUTE_JDE_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.032, when: "item.ood === 'CN'", provenance: HUMAN_PROVENANCE },
      { id: 'FREIGHT_DUTY_US', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.32, composite: true, allocatable: false, when: ["item.ood !== 'CN'", "item.coo === 'US'"], provenance: HUMAN_PROVENANCE },
      { id: 'FREIGHT_DUTY_NONUS', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.21, composite: true, allocatable: false, when: ["item.ood !== 'CN'", "item.coo !== 'US'"], provenance: HUMAN_PROVENANCE },
      { id: 'DIRECT_MARKUP', type: 'FACTOR', basis: ['BASE_COST', 'FREIGHT_DUTY_US', 'FREIGHT_DUTY_NONUS'], rate: 0.032, when: ["item.ood !== 'CN'", "item.supplier !== '88058'"], provenance: HUMAN_PROVENANCE },
      { id: 'LCE_MARKUP_BASE', type: 'FACTOR', basis: ['BASE_COST', 'FREIGHT_DUTY_US', 'FREIGHT_DUTY_NONUS'], rate: 0.032, when: ["item.ood !== 'CN'", "item.supplier === '88058'"], provenance: HUMAN_PROVENANCE },
      { id: 'LCE_MARKUP', type: 'FACTOR', basis: ['BASE_COST', 'FREIGHT_DUTY_US', 'FREIGHT_DUTY_NONUS', 'LCE_MARKUP_BASE'], rate: 0.06, when: ["item.ood !== 'CN'", "item.supplier === '88058'"], provenance: HUMAN_PROVENANCE },
    ],
    // Topic 5: the newest China sheet (with a stakeholder correction comment) says MOLV
    // adjusts QUANTITY, not price -- "Quantity = MOLV/Unit sell price". Older China/Americas
    // sheets describe adjusting cost instead; owner confirmed this is a config decision, not
    // universal, so only China opts into QUANTITY mode here (Europe/Americas keep the default
    // PRICE-adjust FLOOR behavior via their supplier-config-driven MOLV).
    constraints: [
      { id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv', mode: 'QUANTITY', provenance: HUMAN_PROVENANCE },
    ],
    rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
    provenance: HUMAN_PROVENANCE,
  });
}

/**
 * India (topic 4, new region): the reference docs document almost nothing systematic for
 * India — MOLV, freight&duty, and pick cost are all explicitly "NA", and the standard flow is
 * "cost retrieved from India are always RAW costs; user updates cost and manually adds
 * Margin" (a manual/UI concern, not a landed-cost build-up element). The one real rule: an
 * overseas-sourcing markup when the item's origin of data isn't India itself. Owner confirmed
 * the docx's Appendix A figure (+40%) is authoritative over the xlsx India sheet's "1.45%"
 * (almost certainly a x1.45 multiplier written down as "1.45%" by mistake — the two aren't
 * actually describing different rules), and that "OOD is not IN" is what overseas means here.
 * No stock-class split — Appendix A gives India the identical formula for both classes, so no
 * stockClassMap is declared (would only add unnecessary classification risk with no payoff).
 */
function seedIndiaRegionConfig() {
  if (store.listVersions('INDIA', '*').length > 0) return;
  store.saveVersion({
    region: 'INDIA',
    salesOrg: '*',
    version: '2026.08.0',
    status: 'ACTIVE',
    supersedes: null,
    validFrom: '2026-08-01',
    validTo: null,
    resolution: [{ id: 'RES_LOCAL', originOfData: 'IN', costBasis: 'STANDARD', provenance: HUMAN_PROVENANCE }],
    buildUp: [
      { id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE },
      { id: 'OVERSEAS_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.40, when: "item.ood !== 'IN'", provenance: HUMAN_PROVENANCE },
    ],
    constraints: [],
    rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
    provenance: HUMAN_PROVENANCE,
  });
}

/**
 * Americas (topic 4, new region): Non-MTS gets freight+duty+tariff on top of the base cost
 * (per-supplier percentages, via F41291 in the real system — the same shape our existing
 * supplier-config mechanism already models); MTS does not. Both classes get the LCA Handling
 * Fee (this region's name for the SCM markup) and a flat $34 Pick charge (not per-part, unlike
 * Europe's pickCharge fact). LCA Handling Fee has two tiers — local (OOD is Americas' own
 * "SMA") and overseas (anything else) — mirroring India's local/overseas split via the same
 * OOD-based `when` pattern.
 *
 * Two versions are seeded deliberately, as a concrete effective-dated repricing example (the
 * kind CLAUDE.md has flagged as still-needed since Phase 1 started): the real LCA Handling Fee
 * changed 6.2%->6.7% (local) / 10%->10.5% (overseas) effective Jan 2026. Pricing as of a date
 * before 2026-01-01 uses the old rate; on/after uses the new one — engine-core needs zero
 * changes for this, it's purely config-model's effective-dating doing its job.
 */
function seedAmericasRegionConfig() {
  if (store.listVersions('AMERICAS', '*').length > 0) return;
  const stockClassMap = { MTS: 'MTS', 'MTS-Z': 'MTS', 'MTS-2C': 'MTS', OMT: 'NonMTS', SMT: 'NonMTS', CMT: 'NonMTS', MTO: 'NonMTS', MTC: 'NonMTS' };
  const buildUpFor = (localRate, overseasRate) => [
    { id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE },
    { id: 'LCA_HANDLING_LOCAL', type: 'FACTOR', basis: ['BASE_COST'], rate: localRate, when: "item.ood === 'SMA'", provenance: HUMAN_PROVENANCE },
    { id: 'LCA_HANDLING_OVERSEAS', type: 'FACTOR', basis: ['BASE_COST'], rate: overseasRate, when: "item.ood !== 'SMA'", provenance: HUMAN_PROVENANCE },
    { id: 'FREIGHT', type: 'ADDER', amountRef: 'freight', when: "item.stockClass === 'NonMTS'", provenance: HUMAN_PROVENANCE },
    { id: 'DUTY', type: 'ADDER', amountRef: 'duty', when: "item.stockClass === 'NonMTS'", provenance: HUMAN_PROVENANCE },
    { id: 'TARIFF', type: 'ADDER', amountRef: 'tariff', when: "item.stockClass === 'NonMTS'", provenance: HUMAN_PROVENANCE },
    { id: 'PICK_CHARGE', type: 'PER_LINE', amount: 34, provenance: HUMAN_PROVENANCE },
  ];

  store.saveVersion({
    region: 'AMERICAS',
    salesOrg: '*',
    version: '2025.06.0',
    status: 'ACTIVE',
    supersedes: null,
    validFrom: '2025-06-01',
    validTo: null,
    resolution: [{ id: 'RES_JDE_E1', originOfData: 'SMA', costBasis: 'WEIGHTED_AVG', provenance: HUMAN_PROVENANCE }],
    stockClassMap,
    buildUp: buildUpFor(0.062, 0.10),
    constraints: [],
    rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
    provenance: HUMAN_PROVENANCE,
  });
  store.saveVersion({
    region: 'AMERICAS',
    salesOrg: '*',
    version: '2026.01.0',
    status: 'ACTIVE',
    supersedes: '2025.06.0',
    validFrom: '2026-01-01',
    validTo: null,
    resolution: [{ id: 'RES_JDE_E1', originOfData: 'SMA', costBasis: 'WEIGHTED_AVG', provenance: HUMAN_PROVENANCE }],
    stockClassMap,
    buildUp: buildUpFor(0.067, 0.105),
    constraints: [],
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
