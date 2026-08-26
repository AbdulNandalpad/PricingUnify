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
  seedRegionRoutes();
  seedPartyConfigs();
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
    // Non-MTS's real cost source is PIR (Purchase Info Record) data — downloaded from SAP ERP
    // but held for consumption in BI, tagged CCD — so it's tried first for Non-MTS parts,
    // ahead of the original C4C/ERP/CCD/CCP order everything else (including MTS) still uses.
    costAccessSequence: {
      NonMTS: ['CCD', 'C4C', 'ERP', 'CCP'],
      '*': ['C4C', 'ERP', 'CCD', 'CCP'],
    },
    // Normalizes this region's raw ERP stock-class codes into the two canonical buckets
    // buildUp `when` conditions can branch on — see srv/pricing-service.js's
    // applyStockClassNormalization and engine-core/src/kernel.js.
    stockClassMap: { MTS: 'MTS', 'MTS-Z': 'MTS', 'MTS-2C': 'MTS', OMT: 'NonMTS', SMT: 'NonMTS', CMT: 'NonMTS', MTO: 'NonMTS', MTC: 'NonMTS' },
    // Topic 10: the host UI's line-level "Additional Cost" selector (0-4) picks which of
    // these elements apply for that one line, independent of stock class — e.g. "2 - Markup
    // only" means markup fires but freight/duty/tariff/pick don't, even for an otherwise
    // Non-MTS part. See srv/pricing-service.js:applyAdditionalCostFlags.
    additionalCostMap: {
      0: { markup: false, landedCost: false, tariff: false, pick: false }, // "0 - Nothing to add"
      1: { markup: true, landedCost: true, tariff: true, pick: true }, // "1 - Landed cost & Markup"
      2: { markup: true, landedCost: false, tariff: false, pick: false }, // "2 - Markup only"
      3: { markup: true, landedCost: false, tariff: true, pick: false }, // "3 - No Landed cost and Pick" -- tariff isn't named, so it stays included, same "unless explicitly excluded" rule as Pick in options 1/4
      4: { markup: true, landedCost: true, tariff: false, pick: true }, // "4 - Landed cost & Markup, No tariff"
    },
    // Topic 4 (Appendix A): Europe's real formula splits by stock class — Non-MTS gets
    // freight+duty on top of the base cost, MTS does not (moving-average cost is already
    // "clean"). SCM markup and pick apply to both classes either way. Each element also
    // respects the Additional Cost flag above when a line sets one.
    buildUp: [
      { id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE },
      { id: 'SCM_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.047, when: "item.includeMarkup !== false", provenance: HUMAN_PROVENANCE },
      { id: 'FREIGHT', type: 'ADDER', amountRef: 'freight', when: ["item.stockClass === 'NonMTS'", "item.includeLandedCost !== false"], provenance: HUMAN_PROVENANCE },
      { id: 'DUTY', type: 'ADDER', amountRef: 'duty', when: ["item.stockClass === 'NonMTS'", "item.includeLandedCost !== false"], provenance: HUMAN_PROVENANCE },
      { id: 'TARIFF', type: 'ADDER', amountRef: 'tariff', when: "item.includeTariff !== false", provenance: HUMAN_PROVENANCE },
      { id: 'PICK_CHARGE', type: 'PER_LINE', amountRef: 'pickCharge', when: "item.includePick !== false", provenance: HUMAN_PROVENANCE },
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
 * stack applies is a genuine 3-way branch on origin of data, supplier, and the country the
 * F&D rate keys on — not a generic per-region markup. Originally (topic 3) that third
 * dimension was COO, per the owner's stakeholder-corrected reference doc at the time: "OOD
 * needs to be considered in the logic, and NOT the Supplier Country." Later, the owner
 * decided COO and supplierCountry are the same input in practice ("supplier country and
 * country of origin is same so keep only supplier country") and had `item.coo` removed
 * app-wide — China's branch now keys on `item.supplierCountry` instead, same real formula.
 *   - OOD is JDE China ("CN"): the cost JDE China returns is already landed (freight+duty
 *     baked in) — only the 3.2% LCS markup applies.
 *   - OOD is not JDE China, sourced directly from an actual supplier (not 88058/LCE):
 *     freight&duty by supplierCountry (US ×1.32, non-US ×1.21 — a COMPOSITE factor per
 *     requirements §5.1, since the real data is one blended rate, not separate freight/duty
 *     percentages), then the 3.2% LCS markup on top.
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
      { id: 'FREIGHT_DUTY_US', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.32, composite: true, allocatable: false, when: ["item.ood !== 'CN'", "item.supplierCountry === 'US'"], provenance: HUMAN_PROVENANCE },
      { id: 'FREIGHT_DUTY_NONUS', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.21, composite: true, allocatable: false, when: ["item.ood !== 'CN'", "item.supplierCountry !== 'US'"], provenance: HUMAN_PROVENANCE },
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
      // Owner decision (2026-08-26, mockup review): "overseas" means the supplier's actual
      // country, not the item's ood. Unresolved supplierCountry -> overseas branch (+40%),
      // the conservative higher rate — never a silent under-price.
      { id: 'OVERSEAS_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.40, when: "item.supplierCountry !== 'IN'", provenance: HUMAN_PROVENANCE },
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
    // Owner decision (2026-08-26, mockup review): the domestic/overseas split keys off the
    // SUPPLIER's actual country, not the item's ood — the two can genuinely diverge. An
    // unresolved supplierCountry falls into the overseas branch (undefined !== 'US'): the
    // conservative higher rate, never a silent under-price, and visible in the trace.
    { id: 'LCA_HANDLING_LOCAL', type: 'FACTOR', basis: ['BASE_COST'], rate: localRate, when: "item.supplierCountry === 'US'", provenance: HUMAN_PROVENANCE },
    { id: 'LCA_HANDLING_OVERSEAS', type: 'FACTOR', basis: ['BASE_COST'], rate: overseasRate, when: "item.supplierCountry !== 'US'", provenance: HUMAN_PROVENANCE },
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
 * caller names BOTH a supplier and a warehouse that supplier has terms for; with no supplier,
 * no warehouse, or a warehouse the supplier doesn't ship to, pricing uses whatever API6
 * already put in facts.elements (see api6-client/recorded/europe-default.json's tariff:"0",
 * moq:"1" defaults) — there's no wildcard supplier-config entry to fall back to.
 *
 * A supplier is independent of region (owner, 2026-08-26: "supplier is independent of the
 * region... they manufacture items and they send it to warehouse in US or CN or IN or EUR") —
 * one supplier document per supplier id, no region/salesOrg scoping. `supplierCountry` is a
 * single supplier-wide attribute; freight/duty/tariff are per-destination-warehouse, since
 * the same supplier ships the same goods to different warehouses at different logistics
 * costs. ACME deliberately ships to all four regions' warehouses to demonstrate that; GLOBEX
 * and INITECH each ship to a subset.
 */
function seedSupplierConfigs() {
  if (store.listSupplierConfigVersions('ACME').length > 0) return;
  const suppliers = [
    {
      supplier: 'ACME',
      supplierCountry: 'DE',
      molv: '300.00',
      warehouses: {
        EU01: { freight: '18.00', duty: '9.50', tariff: '12.00' },
        US01: { freight: '25.00', duty: '15.00', tariff: '20.00' },
        CN01: { freight: '30.00', duty: '20.00', tariff: '28.00' },
        IN01: { freight: '22.00', duty: '12.00', tariff: '15.00' },
      },
    },
    {
      supplier: 'GLOBEX',
      supplierCountry: 'NL',
      molv: '50.00',
      warehouses: {
        EU01: { freight: '8.00', duty: '4.00', tariff: '5.00' },
      },
    },
    {
      supplier: 'INITECH',
      supplierCountry: 'CN',
      molv: '50.00',
      warehouses: {
        EU01: { freight: '12.00', duty: '6.00', tariff: '20.00' },
        CN01: { freight: '5.00', duty: '2.00', tariff: '3.00' },
      },
    },
    // Exists purely so pricing can resolve item.supplierCountry from supplier master data
    // (owner decision 2026-08-26: the LCA domestic/overseas split keys off the supplier's
    // country, not ood) — no warehouse terms of its own.
    { supplier: 'US-ACME', supplierCountry: 'US' },
    // Dummy test suppliers (2026-08-26, per owner request for more countries/factors to
    // test with): each ships from a different country with deliberately distinct
    // freight/duty/tariff so a tester can tell suppliers apart by the price alone.
    {
      supplier: 'TOKYO',
      supplierCountry: 'JP',
      molv: '500.00',
      warehouses: {
        EU01: { freight: '20.00', duty: '11.00', tariff: '15.00' },
        US01: { freight: '16.00', duty: '8.00', tariff: '22.00' },
        CN01: { freight: '10.00', duty: '5.00', tariff: '6.00' },
      },
    },
    {
      supplier: 'BHARAT',
      supplierCountry: 'IN',
      molv: '20.00',
      warehouses: {
        IN01: { freight: '5.00', duty: '2.00', tariff: '3.00' },
        EU01: { freight: '28.00', duty: '14.00', tariff: '18.00' },
      },
    },
    {
      supplier: 'AZTECA',
      supplierCountry: 'MX',
      molv: '40.00',
      warehouses: {
        US01: { freight: '6.00', duty: '3.00', tariff: '4.00' },
      },
    },
  ];
  for (const s of suppliers) {
    store.saveSupplierConfig({
      version: '2026.08.0',
      status: 'ACTIVE',
      validFrom: '2026-08-01',
      validTo: null,
      provenance: HUMAN_PROVENANCE,
      ...s,
    });
  }
}

/**
 * Real host systems (e.g. C4C) send a customer's Origin of Data + salesOrg, not our internal
 * region code — see CLAUDE.md's C4C payload review. These four are the real combinations the
 * owner shared: SMA/SAP/CN/IN, each an ood-wide ("*" salesOrg) default. A sales-org-specific
 * route only needs its own document where it actually diverges from its ood's default.
 */
function seedRegionRoutes() {
  if (store.listRegionRouteVersions('SAP', '*').length > 0) return;
  const routes = [
    { ood: 'SAP', region: 'EUROPE', entityLabel: 'TSS Germany' },
    { ood: 'SMA', region: 'AMERICAS', entityLabel: 'TSS US Industrial' },
    { ood: 'CN', region: 'CHINA', entityLabel: 'TSS China' },
    { ood: 'IN', region: 'INDIA', entityLabel: 'TSS India' },
  ];
  for (const r of routes) {
    store.saveRegionRoute({
      ood: r.ood,
      salesOrg: '*',
      region: r.region,
      entityLabel: r.entityLabel,
      version: '2026.08.0',
      status: 'ACTIVE',
      validFrom: '2026-08-01',
      validTo: null,
      provenance: HUMAN_PROVENANCE,
    });
  }
}

/**
 * Demo customer master data — first real consumer of `party.customerId`, which the object-
 * agnostic request has carried since Phase 1 (requirements §7) but nothing previously read.
 * CUST-DE-001's customerOod (SAP) matches its country; CUST-US-002 is the "can diverge"
 * demo from the C4C payload review — a US customer (ood SMA) who can still order a part
 * whose own item-level ood/supplierCountry point elsewhere, since item-level routing is independent.
 */
function seedPartyConfigs() {
  if (store.listPartyConfigVersions('CUST-DE-001').length > 0) return;
  store.savePartyConfig({
    customerId: 'CUST-DE-001',
    version: '2026.08.0',
    status: 'ACTIVE',
    validFrom: '2026-08-01',
    validTo: null,
    territory: 'DACH',
    customerCountry: 'DE',
    customerCurrency: 'EUR',
    customerOod: 'SAP',
    provenance: HUMAN_PROVENANCE,
  });
  store.savePartyConfig({
    customerId: 'CUST-US-002',
    version: '2026.08.0',
    status: 'ACTIVE',
    validFrom: '2026-08-01',
    validTo: null,
    territory: 'US-INDUSTRIAL',
    customerCountry: 'US',
    customerCurrency: 'USD',
    customerOod: 'SMA',
    provenance: HUMAN_PROVENANCE,
  });
}

module.exports = { seed };
