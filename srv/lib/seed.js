const HUMAN_PROVENANCE = { source: 'HUMAN', authoredBy: 'seed@tss.example', authoredAt: '2026-08-01T00:00:00Z' };

/**
 * Demo documents for every config kind, as DATA — `seedDocuments()` returns them in
 * dependency order (books before the routing rules that point at them) and `seed(store)`
 * saves them into a ConfigStore. Both srv (on first boot, when ConfigDocuments is empty) and
 * the golden runner (tests/run-golden.js) read the same list, so the finance-verified golden
 * numbers always pin exactly the configuration srv seeds.
 *
 * Synthetic Europe-shaped region-wide defaults, not real TSS rates — matches engine-core's
 * own test fixtures and api6-client's recorded payloads, so the whole stack prices the same
 * known numbers end to end. Real region configs land via the real authoring flow once
 * finance-verified rates exist.
 *
 * v2 (owner decisions 2026-09-10): every region gets a `sell.defaultMargin` — cost plus
 * unitPrice = landedCost / (1 - margin) — parties get a `tier` (+ `segment`, 2026-09-11), and
 * the EU_SEALS price list, BACKUP_RINGS_PTFE catalog + routing rules are seeded ACTIVE from
 * 2026-09-01, real Product_IDs throughout (2026-09-11 data pass — see euSealsPriceList and
 * backupRingsCatalog).
 */
function seedDocuments() {
  return [
    ...regionConfigs().map((doc) => ({ kind: 'region-config', doc })),
    ...supplierConfigs().map((doc) => ({ kind: 'supplier-config', doc })),
    ...regionRoutes().map((doc) => ({ kind: 'region-route', doc })),
    ...partyConfigs().map((doc) => ({ kind: 'party-config', doc })),
    { kind: 'price-list', doc: euSealsPriceList() },
    { kind: 'catalog-book', doc: backupRingsCatalog() },
    { kind: 'routing-rules', doc: routingRules() },
  ];
}

/** Saves every seed document that is not already in the store (idempotent per bucket). */
function seed(store) {
  for (const { kind, doc } of seedDocuments()) {
    const key = kindKey(kind, doc);
    if (store.listVersions(kind, key).some((v) => String(v.version) === String(doc.version))) continue;
    store.saveSync(kind, doc);
  }
}

function kindKey(kind, doc) {
  const { docKeyOf } = require('@tss-pricing/config-model');
  return docKeyOf(kind, doc);
}

const STOCK_CLASS_MAP = { MTS: 'MTS', 'MTS-Z': 'MTS', 'MTS-2C': 'MTS', OMT: 'NonMTS', SMT: 'NonMTS', CMT: 'NonMTS', MTO: 'NonMTS', MTC: 'NonMTS' };

// Cost plus sell margins per region (owner decision 2026-09-10) — the only v2 addition to
// the region documents; every landed-cost element below is exactly as it was.
const SELL = { EUROPE: 0.30, CHINA: 0.25, INDIA: 0.28, AMERICAS: 0.32 };

function regionConfigs() {
  return [europeRegionConfig(), chinaRegionConfig(), indiaRegionConfig(), ...americasRegionConfigs()];
}

function europeRegionConfig() {
  return {
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
    // buildUp `when` conditions can branch on — see srv/lib/pricing.js's
    // applyStockClassNormalization and engine-core/src/kernel.js.
    stockClassMap: STOCK_CLASS_MAP,
    // Topic 10: the host UI's line-level "Additional Cost" selector (0-4) picks which of
    // these elements apply for that one line, independent of stock class — e.g. "2 - Markup
    // only" means markup fires but freight/duty/tariff/pick don't, even for an otherwise
    // Non-MTS part. See srv/lib/pricing.js:applyAdditionalCostFlags.
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
    // Owner correction (2026-08-26): freight, duty and tariff are PERCENTAGES applied on
    // (base cost + markup), not fixed amounts — FACTORs with basis [BASE_COST, SCM_MARKUP],
    // rates read per line from the part's data / the supplier's warehouse terms (a rate of
    // 0.10 = 10%). A skipped SCM_MARKUP (Additional Cost flag) contributes 0 to the basis,
    // so the percentages then apply on the base cost alone.
    buildUp: [
      { id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE },
      { id: 'SCM_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.047, when: 'item.includeMarkup !== false', provenance: HUMAN_PROVENANCE },
      { id: 'FREIGHT', type: 'FACTOR', basis: ['BASE_COST', 'SCM_MARKUP'], rateRef: 'freight', when: ["item.stockClass === 'NonMTS'", 'item.includeLandedCost !== false'], provenance: HUMAN_PROVENANCE },
      { id: 'DUTY', type: 'FACTOR', basis: ['BASE_COST', 'SCM_MARKUP'], rateRef: 'duty', when: ["item.stockClass === 'NonMTS'", 'item.includeLandedCost !== false'], provenance: HUMAN_PROVENANCE },
      { id: 'TARIFF', type: 'FACTOR', basis: ['BASE_COST', 'SCM_MARKUP'], rateRef: 'tariff', when: 'item.includeTariff !== false', provenance: HUMAN_PROVENANCE },
      { id: 'PICK_CHARGE', type: 'PER_LINE', amountRef: 'pickCharge', when: 'item.includePick !== false', provenance: HUMAN_PROVENANCE },
    ],
    constraints: [
      { id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv', provenance: HUMAN_PROVENANCE },
      { id: 'MOQ', type: 'CONSTRAINT', kind: 'MIN_QTY', minRef: 'moq', provenance: HUMAN_PROVENANCE },
    ],
    rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
    sell: { defaultMargin: SELL.EUROPE },
    provenance: HUMAN_PROVENANCE,
  };
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
function chinaRegionConfig() {
  return {
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
    stockClassMap: STOCK_CLASS_MAP,
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
    sell: { defaultMargin: SELL.CHINA },
    provenance: HUMAN_PROVENANCE,
  };
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
function indiaRegionConfig() {
  return {
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
    sell: { defaultMargin: SELL.INDIA },
    provenance: HUMAN_PROVENANCE,
  };
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
 * Two versions are seeded deliberately, as a concrete effective-dated repricing example: the
 * real LCA Handling Fee changed 6.2%->6.7% (local) / 10%->10.5% (overseas) effective Jan
 * 2026. Pricing as of a date before 2026-01-01 uses the old rate; on/after uses the new one —
 * engine-core needs zero changes for this, it's purely config-model's effective-dating doing
 * its job.
 */
function americasRegionConfigs() {
  const buildUpFor = (localRate, overseasRate) => [
    { id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE },
    // Owner decision (2026-08-26, mockup review): the domestic/overseas split keys off the
    // SUPPLIER's actual country, not the item's ood — the two can genuinely diverge. An
    // unresolved supplierCountry falls into the overseas branch (undefined !== 'US'): the
    // conservative higher rate, never a silent under-price, and visible in the trace.
    { id: 'LCA_HANDLING_LOCAL', type: 'FACTOR', basis: ['BASE_COST'], rate: localRate, when: "item.supplierCountry === 'US'", provenance: HUMAN_PROVENANCE },
    { id: 'LCA_HANDLING_OVERSEAS', type: 'FACTOR', basis: ['BASE_COST'], rate: overseasRate, when: "item.supplierCountry !== 'US'", provenance: HUMAN_PROVENANCE },
    // Owner correction (2026-08-26): freight/duty/tariff are percentages on (base cost +
    // markup) — here the markup is the LCA Handling Fee, whichever tier fired (the skipped
    // tier contributes 0 to the basis, the topic-3 mechanism).
    { id: 'FREIGHT', type: 'FACTOR', basis: ['BASE_COST', 'LCA_HANDLING_LOCAL', 'LCA_HANDLING_OVERSEAS'], rateRef: 'freight', when: "item.stockClass === 'NonMTS'", provenance: HUMAN_PROVENANCE },
    { id: 'DUTY', type: 'FACTOR', basis: ['BASE_COST', 'LCA_HANDLING_LOCAL', 'LCA_HANDLING_OVERSEAS'], rateRef: 'duty', when: "item.stockClass === 'NonMTS'", provenance: HUMAN_PROVENANCE },
    { id: 'TARIFF', type: 'FACTOR', basis: ['BASE_COST', 'LCA_HANDLING_LOCAL', 'LCA_HANDLING_OVERSEAS'], rateRef: 'tariff', when: "item.stockClass === 'NonMTS'", provenance: HUMAN_PROVENANCE },
    { id: 'PICK_CHARGE', type: 'PER_LINE', amount: 34, provenance: HUMAN_PROVENANCE },
  ];
  const common = {
    region: 'AMERICAS',
    salesOrg: '*',
    resolution: [{ id: 'RES_JDE_E1', originOfData: 'SMA', costBasis: 'WEIGHTED_AVG', provenance: HUMAN_PROVENANCE }],
    stockClassMap: STOCK_CLASS_MAP,
    constraints: [],
    rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
    sell: { defaultMargin: SELL.AMERICAS },
    provenance: HUMAN_PROVENANCE,
  };
  return [
    { ...common, version: '2025.06.0', status: 'ACTIVE', supersedes: null, validFrom: '2025-06-01', validTo: null, buildUp: buildUpFor(0.062, 0.10) },
    { ...common, version: '2026.01.0', status: 'ACTIVE', supersedes: '2025.06.0', validFrom: '2026-01-01', validTo: null, buildUp: buildUpFor(0.067, 0.105) },
  ];
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
function supplierConfigs() {
  const suppliers = [
    {
      supplier: 'ACME',
      supplierCountry: 'DE',
      molv: '300.00',
      warehouses: {
        EU01: { freight: '0.18', duty: '0.095', tariff: '0.12' },
        US01: { freight: '0.25', duty: '0.15', tariff: '0.2' },
        CN01: { freight: '0.3', duty: '0.2', tariff: '0.28' },
        IN01: { freight: '0.22', duty: '0.12', tariff: '0.15' },
      },
    },
    { supplier: 'GLOBEX', supplierCountry: 'NL', molv: '50.00', warehouses: { EU01: { freight: '0.08', duty: '0.04', tariff: '0.05' } } },
    {
      supplier: 'INITECH',
      supplierCountry: 'CN',
      molv: '50.00',
      warehouses: { EU01: { freight: '0.12', duty: '0.06', tariff: '0.2' }, CN01: { freight: '0.05', duty: '0.02', tariff: '0.03' } },
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
      warehouses: { EU01: { freight: '0.2', duty: '0.11', tariff: '0.15' }, US01: { freight: '0.16', duty: '0.08', tariff: '0.22' }, CN01: { freight: '0.1', duty: '0.05', tariff: '0.06' } },
    },
    { supplier: 'BHARAT', supplierCountry: 'IN', molv: '20.00', warehouses: { IN01: { freight: '0.05', duty: '0.02', tariff: '0.03' }, EU01: { freight: '0.28', duty: '0.14', tariff: '0.18' } } },
    { supplier: 'AZTECA', supplierCountry: 'MX', molv: '40.00', warehouses: { US01: { freight: '0.06', duty: '0.03', tariff: '0.04' } } },
  ];
  return suppliers.map((s) => ({ version: '2026.08.0', status: 'ACTIVE', validFrom: '2026-08-01', validTo: null, provenance: HUMAN_PROVENANCE, ...s }));
}

/**
 * Real host systems (e.g. C4C) send a customer's Origin of Data + salesOrg, not our internal
 * region code — see CLAUDE.md's C4C payload review. These four are the real combinations the
 * owner shared: SMA/SAP/CN/IN, each an ood-wide ("*" salesOrg) default. A sales-org-specific
 * route only needs its own document where it actually diverges from its ood's default.
 */
function regionRoutes() {
  return [
    { ood: 'SAP', region: 'EUROPE', entityLabel: 'TSS Germany' },
    { ood: 'SMA', region: 'AMERICAS', entityLabel: 'TSS US Industrial' },
    { ood: 'CN', region: 'CHINA', entityLabel: 'TSS China' },
    { ood: 'IN', region: 'INDIA', entityLabel: 'TSS India' },
  ].map((r) => ({ ...r, salesOrg: '*', version: '2026.08.0', status: 'ACTIVE', validFrom: '2026-08-01', validTo: null, provenance: HUMAN_PROVENANCE }));
}

/**
 * Demo customer master data — the consumer of `party.customerId` (requirements §7).
 * CUST-DE-001's customerOod (SAP) matches its country; CUST-US-002 is the "can diverge" demo
 * from the C4C payload review — a US customer (ood SMA) who can still order a part whose own
 * item-level ood/supplierCountry point elsewhere. v2 adds `tier`, the price-list / catalog
 * dimension (A = key account, B = standard), plus three more customers so every region has a
 * customer to demo price lists against.
 *
 * `segment` (owner request 2026-09-11, real TSS product data pass): the customer's industry —
 * IND (industrial), AUT (automotive), AER (aerospace) — a second price-list / catalog
 * dimension used by the real O-Ring rows (euSealsPriceList) and the back-up-ring catalog
 * (backupRingsCatalog). No real customer names needed; segment differentiates the demo
 * instead of a region or a named account. CUST-US-006 is added purely to have an aerospace
 * example — the segment aerospace pricing needs to demo against.
 */
function partyConfigs() {
  const base = { version: '2026.08.0', status: 'ACTIVE', validFrom: '2026-08-01', validTo: null, provenance: HUMAN_PROVENANCE };
  return [
    { ...base, customerId: 'CUST-DE-001', territory: 'DACH', customerCountry: 'DE', customerCurrency: 'EUR', customerOod: 'SAP', tier: 'A', segment: 'IND' },
    { ...base, customerId: 'CUST-US-002', territory: 'US-INDUSTRIAL', customerCountry: 'US', customerCurrency: 'USD', customerOod: 'SMA', tier: 'B', segment: 'AUT' },
    { ...base, customerId: 'CUST-DE-007', territory: 'DACH', customerCountry: 'DE', customerCurrency: 'EUR', customerOod: 'SAP', tier: 'B', segment: 'IND' },
    { ...base, customerId: 'CUST-CN-003', territory: 'CN-CONSTRUCTION', customerCountry: 'CN', customerCurrency: 'CNY', customerOod: 'CN', tier: 'A', segment: 'IND' },
    { ...base, customerId: 'CUST-IN-004', territory: 'IN-CONSTRUCTION', customerCountry: 'IN', customerCurrency: 'INR', customerOod: 'IN', tier: 'B', segment: 'IND' },
    { ...base, customerId: 'CUST-US-006', territory: 'US-AEROSPACE', customerCountry: 'US', customerCurrency: 'USD', customerOod: 'SMA', tier: 'A', segment: 'AER' },
  ];
}

/**
 * EU standard seals price list — a SELL price book (ARCHITECTURE_V2 §2.6). Rows are real
 * O-Ring Product_IDs from the attached C4C product export (category "OR", material NBR, real
 * hardness grades) — the original placeholder rows (OR-25X3-NBR, OR-40X5-FKM) were removed
 * 2026-09-11 once real data existed for the same category (owner: "remove the other seed data
 * which is not of tss"). engine-core/test/techniques.test.js pins its own self-contained
 * EU_SEALS fixture for unit-testing the kernel — it does not read this file, so it is
 * unaffected by what this function returns.
 *
 * A `segment` dimension (IND/AUT/AER — see partyConfigs) sits alongside customer/tier/region.
 * The four real parts tell a pricing story, not just four numbers:
 *  - OR00007771N7022 (NBR70, the most common hardness in the export — 399 of 1169 O-Ring
 *    SKUs): general-purpose, IND gets the volume discount that high-turnover industrial
 *    accounts negotiate.
 *  - OR1901250AN8I25 (NBR80, higher durometer for dynamic/vibration duty): AUT gets its own
 *    tiers — automotive buys in volume but at a tighter margin than industrial.
 *  - OR1900380-N9019 (NBR90, the hardest/most demanding grade in the export): AER is priced
 *    HIGHER than the default row, not lower — aerospace pays a premium for full material
 *    traceability and certification, small lots, no volume break.
 *  - OR00005678NC001 (NBR75): deliberately has no segment-specific row at all, to show the
 *    plain case — everyone gets the same tiered list price.
 */
function euSealsPriceList() {
  return {
    id: 'EU_SEALS',
    name: 'EU standard seals',
    version: '2026.09.1',
    status: 'ACTIVE',
    supersedes: null,
    validFrom: '2026-09-01',
    validTo: null,
    currency: 'EUR',
    appliesWhen: { region: 'EUROPE', family: 'O-Rings' },
    dimensions: [
      { attr: 'segment', label: 'Segment', weight: 40 },
      { attr: 'tier', label: 'Tier', weight: 30 },
    ],
    rows: [
      // Real O-Ring #1 — NBR70, general purpose. Industrial volume discount.
      { part: 'OR00007771N7022', match: {}, tiers: [{ from: 0, value: '0.85' }, { from: 1000, value: '0.75' }, { from: 5000, value: '0.62' }], validFrom: '2026-01-01' },
      { part: 'OR00007771N7022', match: { segment: 'IND' }, tiers: [{ from: 0, value: '0.78' }, { from: 1000, value: '0.68' }, { from: 5000, value: '0.55' }], validFrom: '2026-01-01' },
      // Real O-Ring #2 — NBR80, dynamic duty. Automotive volume tiers, tighter than default.
      { part: 'OR1901250AN8I25', match: {}, tiers: [{ from: 0, value: '1.35' }, { from: 500, value: '1.18' }], validFrom: '2026-01-01' },
      { part: 'OR1901250AN8I25', match: { segment: 'AUT' }, tiers: [{ from: 0, value: '1.22' }, { from: 500, value: '1.05' }, { from: 2000, value: '0.94' }], validFrom: '2026-01-01' },
      // Real O-Ring #3 — NBR90, hardest grade. Aerospace pays MORE — traceability/cert premium.
      { part: 'OR1900380-N9019', match: {}, tiers: [{ from: 0, value: '3.60' }], validFrom: '2026-01-01' },
      { part: 'OR1900380-N9019', match: { segment: 'AER' }, tiers: [{ from: 0, value: '4.95' }], validFrom: '2026-01-01' },
      // Real O-Ring #4 — NBR75. No segment row: everyone gets the same tiered list price.
      { part: 'OR00005678NC001', match: {}, tiers: [{ from: 0, value: '0.60' }, { from: 2000, value: '0.50' }], validFrom: '2026-01-01' },
    ],
    discount: [{ match: { tier: 'A' }, value: '0.03' }, { match: {}, value: 0 }],
    constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', min: 100, mode: 'PRICE', provenance: HUMAN_PROVENANCE }],
    provenance: HUMAN_PROVENANCE,
  };
}

/**
 * PTFE back-up rings — the sole catalog + formula book now seeded (owner, 2026-09-11: real
 * TSS product data pass). It was built as its own book rather than folded into the original
 * placeholder PTFE_BEARINGS book because engine-core's `matchOn` is uniform across a whole
 * book (every row is checked against every key in `matchOn`) — adding `cross_section_mm` to
 * PTFE_BEARINGS' matchOn would have broken its spec/variant rows (they'd fail the new key's
 * presence check). PTFE_BEARINGS (fake Product_IDs, spec 120/160) was removed once this real
 * book existed — a back-up ring isn't the same product family as a PTFE slide bearing anyway.
 *
 * Real Product_IDs from the attached C4C export (category "BB", material PTFE), by real
 * cross-section (the export's `Width` field): 1.52mm and 4.65mm get negotiated catalog rates;
 * 3.00mm (BBP80B242-PT008) has no row — genuinely "in between" the two catalog sizes — so it
 * falls to the fallback formula, exactly the demo the owner asked for. Cost inputs are example
 * figures (material rate per mm of cross-section + a per-order machining/tooling setup), not
 * finance-verified, same convention as every other cost input in this file.
 */
function backupRingsCatalog() {
  return {
    id: 'BACKUP_RINGS_PTFE',
    name: 'PTFE back-up rings',
    version: '2026.09.1',
    status: 'ACTIVE',
    supersedes: null,
    validFrom: '2026-09-01',
    validTo: null,
    currency: 'EUR',
    dsl_version: 1,
    appliesWhen: { family: 'Back-up rings' },
    matchOn: ['cross_section_mm'],
    dimensions: [
      { attr: 'segment', label: 'Segment', weight: 40 },
      { attr: 'tier', label: 'Tier', weight: 30 },
    ],
    rows: [
      { match: { cross_section_mm: '1.52' }, rate: '2.40' }, // BBP80B324-PT004
      { match: { cross_section_mm: '4.65' }, rate: '6.80' }, // BBP80B358-PT004
    ],
    fallbackFormula: 'cross_section_mm * cost.ptfe_rate_per_mm_cs + cost.machining_setup / quantity',
    costInputs: {
      ptfe_rate_per_mm_cs: { value: '1.35', unit: 'EUR / mm cross-section', validFrom: '2026-08-01', source: 'MANUAL' },
      machining_setup: { value: '12.00', unit: 'EUR / order', validFrom: '2026-08-01', source: 'MANUAL' },
    },
    freight: 0,
    // Aerospace back-up rings carry the same traceability premium as the aerospace O-Ring row
    // above; automotive gets the tighter volume-driven margin.
    margin: [{ match: { segment: 'AER' }, value: '0.28' }, { match: { segment: 'AUT' }, value: '0.16' }, { match: {}, value: '0.20' }],
    floor: '0.12',
    discount: [{ match: { tier: 'A' }, value: '0.02' }, { match: {}, value: 0 }],
    provenance: HUMAN_PROVENANCE,
  };
}

/** Which technique prices a line (ARCHITECTURE_V2 §2.5): O-Rings → the EU price list,
 *  back-up rings → their own catalog; everything else defaults to cost plus with the region
 *  config. The placeholder PTFE_BEARINGS book (spec 120/160, fake Product_IDs) was removed
 *  2026-09-11 — real data (BACKUP_RINGS_PTFE) fully replaces it; PTFE_BEARINGS lives on only
 *  as engine-core/test/techniques.test.js's own self-contained fixture, which reads none of
 *  this file. */
function routingRules() {
  return {
    key: '*',
    version: '2026.09.1',
    status: 'ACTIVE',
    supersedes: null,
    validFrom: '2026-09-01',
    validTo: null,
    rules: [
      { when: { family: 'O-Rings' }, type: 'PRICE_LIST', book: 'EU_SEALS' },
      { when: { family: 'Back-up rings' }, type: 'CATALOG_FORMULA', book: 'BACKUP_RINGS_PTFE' },
    ],
    provenance: HUMAN_PROVENANCE,
  };
}

module.exports = { seed, seedDocuments, HUMAN_PROVENANCE, SELL };
