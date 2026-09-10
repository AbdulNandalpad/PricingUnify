/** DEV AID ONLY — sample data for `mockApi.js` (enabled with `VITE_API_MODE=mock`).
 *  The prototype's seed (docs/prototype/pricingunify-prototype.html) re-expressed in the real
 *  config-document shapes: region-config, supplier-config, region-route, party-config,
 *  price-list, catalog-book, routing-rules (see engine-core/test/techniques.test.js). */

const PROV = { source: 'HUMAN', authoredBy: 'seed@tss', authoredAt: '2026-08-01T00:00:00Z' };
const PUB = { ...PROV, publishedBy: 'bob', publishedAt: '2026-09-01T08:00:00Z' };

const cand = (key, value, currency, basis, system, table, field, confidence, validFrom) => ({
  value: String(value), currency, basis, source: { system, table, field, key }, confidence, validFrom, retrievedAt: '2026-08-20T00:00:00Z',
});

/** Item master + facts (what API6 / C4C would deliver). */
export const PARTS = {
  'EU-T100': { description: 'Turcon® Stepseal® 2K rod seal, Ø60', family: 'Hydraulic seals', stockClassRaw: 'OMT', costs: [cand('PIR_1', 100, 'EUR', 'SUPPLIER_CATALOG', 'CCD', 'EINE', 'NETPR', 'EXACT', '2026-08-01')], elements: { freight: 0.10, duty: 0.05, tariff: 0.08, pickCharge: 20, molv: 50, moq: 1 } },
  'P-10023': { description: 'Zurcon® DA24 wiper seal, Ø45', family: 'Hydraulic seals', stockClassRaw: 'MTS', costs: [cand('MAV_1', 100, 'EUR', 'MOVING_AVG', 'ERP', 'MBEW', 'VERPR', 'EXACT', '2026-08-01')], elements: { freight: 0.05, duty: 0.02, tariff: 0, pickCharge: 21, molv: 50, moq: 1 } },
  'P-70200': { description: 'Glyd Ring® T piston seal, Ø80', family: 'Hydraulic seals', stockClassRaw: 'CMT', costs: [cand('PIR_1', 150, 'EUR', 'SUPPLIER_CATALOG', 'CCD', 'EINE', 'NETPR', 'EXACT', '2026-08-01')], elements: { freight: 0.06, duty: 0.022, tariff: 0, pickCharge: 21, molv: 50, moq: 25 } },
  'P-60150': { description: 'Rotary shaft seal FKM, Ø35', family: 'Rotary seals', stockClassRaw: 'MTS', costs: [cand('ERP_1', 200, 'EUR', 'MOVING_AVG', 'ERP', 'MBEW', 'VERPR', 'EXACT', '2026-08-01'), cand('C4C_1', 180, 'EUR', 'MANUAL', 'C4C', 'QUOTE_LINE', 'MANUAL_COST', 'EXACT', '2026-08-20')], elements: { freight: 0.08, duty: 0.035, tariff: 0, pickCharge: 21, molv: 50, moq: 1 } },
  'P-40012': { description: 'Back-up ring PTFE, Ø20', family: 'Hydraulic seals', stockClassRaw: 'MTO', costs: [cand('SUP_1', 19.90, 'EUR', 'SUPPLIER_CATALOG', 'CCD', 'CATALOG', 'PRICE', 'FALLBACK', '2026-08-01')], elements: { freight: 0.015, duty: 0.004, tariff: 0, pickCharge: 21, molv: 50, moq: 1 } },
  'P-90600': { description: 'Zurcon® U-cup 32×40, quantity-break part', family: 'Hydraulic seals', stockClassRaw: 'MTO', costs: [cand('SUP_1', 18.49, 'EUR', 'SUPPLIER_CATALOG', 'JDE_E1', 'F41291', 'UNIT_COST', 'EXACT', '2026-08-01')], elements: { freight: 0, duty: 0, tariff: 0, pickCharge: 21, molv: 50, moq: 1 }, qtyBreaks: [{ minQty: 10, value: 18.49 }, { minQty: 25, value: 15.41 }, { minQty: 50, value: 12.84 }, { minQty: 100, value: 10.70 }, { minQty: 250, value: 7.58 }] },
  'OR-25X3-NBR': { description: 'O-Ring 25×3 NBR 70 Sh', family: 'O-Rings', spec: '25x3', variant: 'NBR70' },
  'OR-40X5-FKM': { description: 'O-Ring 40×5 FKM 75 Sh', family: 'O-Rings', spec: '40x5', variant: 'FKM75' },
  'PTFE-BRG-120': { description: 'PTFE slide bearing, Ø120 standard', family: 'PTFE bearings', spec: '120', variant: 'standard', diameter_mm: 120 },
  'PTFE-BRG-137': { description: 'PTFE slide bearing, Ø137 custom bore', family: 'PTFE bearings', spec: '137', variant: 'custom', diameter_mm: 137 },
  'CN-T100': { description: 'Verification part, China', family: 'Hydraulic seals', stockClassRaw: 'MTS', ood: 'CN', costs: [cand('JDE_1', 100, 'CNY', 'MOVING_AVG', 'JDE_CN', 'F4105', 'UNCS', 'EXACT', '2026-08-01')], elements: { molv: 500 } },
  'IN-T100': { description: 'Verification part, India', family: 'Hydraulic seals', stockClassRaw: 'MTS', costs: [cand('FS_1', 100, 'INR', 'STANDARD', 'FOURTH_SHIFT', 'ITEM', 'COST', 'EXACT', '2026-08-01')], elements: {} },
  'US-T100': { description: 'Verification part, Americas', family: 'Hydraulic seals', stockClassRaw: 'OMT', costs: [cand('JDE_1', 100, 'USD', 'WEIGHTED_AVG', 'JDE_E1', 'F4105', 'UNCS', 'EXACT', '2026-08-01')], elements: { freight: 0.10, duty: 0.05, tariff: 0.08 } },
};

const REGION_BASE = {
  EUROPE: {
    currency: 'EUR', sell: { defaultMargin: 0.30 }, rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
    costAccessSequence: { NonMTS: ['CCD', 'C4C', 'ERP', 'CCP'], '*': ['C4C', 'ERP', 'CCD', 'CCP'] },
    stockClassMap: { MTS: 'MTS', 'MTS-Z': 'MTS', 'MTS-2C': 'MTS', OMT: 'NonMTS', SMT: 'NonMTS', CMT: 'NonMTS', MTO: 'NonMTS', MTC: 'NonMTS' },
    additionalCostMap: {
      0: { label: 'Nothing to add', markup: false, landedCost: false, tariff: false, pick: false },
      1: { label: 'Landed cost & markup', markup: true, landedCost: true, tariff: true, pick: true },
      2: { label: 'Markup only', markup: true, landedCost: false, tariff: false, pick: false },
      3: { label: 'No landed cost and pick', markup: true, landedCost: false, tariff: true, pick: false },
      4: { label: 'Landed cost & markup, no tariff', markup: true, landedCost: true, tariff: false, pick: true },
    },
    buildUp: [
      { id: 'BASE_COST', type: 'BASE' },
      { id: 'SCM_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.047, when: 'item.includeMarkup !== false' },
      { id: 'FREIGHT', type: 'FACTOR', basis: ['BASE_COST', 'SCM_MARKUP'], rateRef: 'freight', when: ["item.stockClass === 'NonMTS'", 'item.includeLandedCost !== false'] },
      { id: 'DUTY', type: 'FACTOR', basis: ['BASE_COST', 'SCM_MARKUP'], rateRef: 'duty', when: ["item.stockClass === 'NonMTS'", 'item.includeLandedCost !== false'] },
      { id: 'TARIFF', type: 'FACTOR', basis: ['BASE_COST', 'SCM_MARKUP'], rateRef: 'tariff', when: 'item.includeTariff !== false' },
      { id: 'PICK_CHARGE', type: 'PER_LINE', amountRef: 'pickCharge', when: 'item.includePick !== false' },
    ],
    constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv', mode: 'PRICE' }, { id: 'MOQ', type: 'CONSTRAINT', kind: 'MIN_QTY', minRef: 'moq' }],
  },
  CHINA: {
    currency: 'CNY', sell: { defaultMargin: 0.25 }, rounding: { mode: 'HALF_UP', decimalPlaces: 2 }, costAccessSequence: ['JDE_CN', 'SAP'],
    stockClassMap: { MTS: 'MTS', 'MTS-Z': 'MTS', OMT: 'NonMTS', SMT: 'NonMTS', CMT: 'NonMTS', MTO: 'NonMTS' },
    buildUp: [
      { id: 'BASE_COST', type: 'BASE' },
      { id: 'ROUTE_JDE_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.032, when: "item.ood === 'CN'" },
      { id: 'FREIGHT_DUTY_US', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.32, when: ["item.ood !== 'CN'", "item.supplierCountry === 'US'"] },
      { id: 'FREIGHT_DUTY_NONUS', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.21, when: ["item.ood !== 'CN'", "item.supplierCountry !== 'US'"] },
      { id: 'DIRECT_MARKUP', type: 'FACTOR', basis: ['BASE_COST', 'FREIGHT_DUTY_US', 'FREIGHT_DUTY_NONUS'], rate: 0.032, when: ["item.ood !== 'CN'", "item.supplier !== '88058'"] },
      { id: 'LCE_MARKUP_BASE', type: 'FACTOR', basis: ['BASE_COST', 'FREIGHT_DUTY_US', 'FREIGHT_DUTY_NONUS'], rate: 0.032, when: ["item.ood !== 'CN'", "item.supplier === '88058'"] },
      { id: 'LCE_MARKUP', type: 'FACTOR', basis: ['BASE_COST', 'FREIGHT_DUTY_US', 'FREIGHT_DUTY_NONUS', 'LCE_MARKUP_BASE'], rate: 0.06, when: ["item.ood !== 'CN'", "item.supplier === '88058'"] },
    ],
    constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv', mode: 'QUANTITY' }],
  },
  INDIA: {
    currency: 'INR', sell: { defaultMargin: 0.28 }, rounding: { mode: 'HALF_UP', decimalPlaces: 2 }, costAccessSequence: ['FOURTH_SHIFT'],
    buildUp: [{ id: 'BASE_COST', type: 'BASE' }, { id: 'OVERSEAS_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.40, when: "item.supplierCountry !== 'IN'" }],
    constraints: [],
  },
  AMERICAS: {
    currency: 'USD', sell: { defaultMargin: 0.32 }, rounding: { mode: 'HALF_UP', decimalPlaces: 2 }, costAccessSequence: ['JDE_E1'],
    stockClassMap: { MTS: 'MTS', 'MTS-Z': 'MTS', 'MTS-2C': 'MTS', OMT: 'NonMTS', SMT: 'NonMTS', CMT: 'NonMTS', MTO: 'NonMTS' },
    buildUp: [
      { id: 'BASE_COST', type: 'BASE' },
      { id: 'LCA_HANDLING_LOCAL', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.067, when: "item.supplierCountry === 'US'" },
      { id: 'LCA_HANDLING_OVERSEAS', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.105, when: "item.supplierCountry !== 'US'" },
      { id: 'FREIGHT', type: 'FACTOR', basis: ['BASE_COST', 'LCA_HANDLING_LOCAL', 'LCA_HANDLING_OVERSEAS'], rateRef: 'freight', when: "item.stockClass === 'NonMTS'" },
      { id: 'DUTY', type: 'FACTOR', basis: ['BASE_COST', 'LCA_HANDLING_LOCAL', 'LCA_HANDLING_OVERSEAS'], rateRef: 'duty', when: "item.stockClass === 'NonMTS'" },
      { id: 'TARIFF', type: 'FACTOR', basis: ['BASE_COST', 'LCA_HANDLING_LOCAL', 'LCA_HANDLING_OVERSEAS'], rateRef: 'tariff', when: "item.stockClass === 'NonMTS'" },
      { id: 'PICK_CHARGE', type: 'PER_LINE', amount: 34 },
    ],
    constraints: [],
  },
};

function versioned(doc, version, status, validFrom, validTo, provenance) {
  return { ...doc, version, status, validFrom, validTo: validTo ?? null, supersedes: null, provenance };
}

export function seedDocuments() {
  const docs = [];
  const add = (kind, key, doc) => docs.push({ kind, key, version: doc.version, status: doc.status, validFrom: doc.validFrom, validTo: doc.validTo, doc });

  for (const [region, cfg] of Object.entries(REGION_BASE)) {
    const key = `${region}::*`;
    // an older version so history has something to show — same rules, slightly lower margin
    const old = { ...cfg, sell: { defaultMargin: Math.round((cfg.sell.defaultMargin - 0.02) * 100) / 100 } };
    add('region-config', key, versioned({ region, salesOrg: '*', ...old }, '2026.08.0', 'SUPERSEDED', '2026-08-01', '2026-09-01', { ...PUB, publishedAt: '2026-08-01T08:00:00Z', note: 'All four regions seeded from Appendix A' }));
    add('region-config', key, versioned({ region, salesOrg: '*', ...cfg }, '2026.09.1', 'ACTIVE', '2026-09-01', null, { ...PUB, note: 'Sell margin per region; freight/duty/tariff as % on base + markup' }));
  }

  const suppliers = {
    ACME: { supplierCountry: 'DE', molv: 300, warehouses: { EU01: { freight: 0.18, duty: 0.095, tariff: 0.12 }, US01: { freight: 0.25, duty: 0.15, tariff: 0.20 }, CN01: { freight: 0.30, duty: 0.20, tariff: 0.28 }, IN01: { freight: 0.22, duty: 0.12, tariff: 0.15 } } },
    GLOBEX: { supplierCountry: 'NL', molv: 50, warehouses: { EU01: { freight: 0.08, duty: 0.04, tariff: 0.05 } } },
    INITECH: { supplierCountry: 'CN', molv: 50, warehouses: { EU01: { freight: 0.12, duty: 0.06, tariff: 0.20 }, CN01: { freight: 0.05, duty: 0.02, tariff: 0.03 } } },
    TOKYO: { supplierCountry: 'JP', molv: 500, warehouses: { EU01: { freight: 0.20, duty: 0.11, tariff: 0.15 }, US01: { freight: 0.16, duty: 0.08, tariff: 0.22 } } },
    BHARAT: { supplierCountry: 'IN', molv: 20, warehouses: { IN01: { freight: 0.05, duty: 0.02, tariff: 0.03 }, EU01: { freight: 0.28, duty: 0.14, tariff: 0.18 } } },
    'US-ACME': { supplierCountry: 'US', molv: null, warehouses: {} },
  };
  for (const [supplier, s] of Object.entries(suppliers)) add('supplier-config', supplier, versioned({ supplier, ...s }, '2026.08.0', 'ACTIVE', '2026-08-01', null, PUB));

  const routes = { SAP: ['EUROPE', 'TSS Germany'], SMA: ['AMERICAS', 'TSS US Industrial'], CN: ['CHINA', 'TSS China'], IN: ['INDIA', 'TSS India'] };
  for (const [ood, [region, entityLabel]] of Object.entries(routes)) add('region-route', `${ood}::*`, versioned({ ood, salesOrg: '*', region, entityLabel }, '2026.08.0', 'ACTIVE', '2026-08-01', null, PUB));

  const customers = {
    'CUST-DE-001': { name: 'Bosch Rexroth AG', tier: 'A', customerCountry: 'DE', customerCurrency: 'EUR', customerOod: 'SAP', territory: 'DE01' },
    'CUST-DE-007': { name: 'HYDAC International', tier: 'B', customerCountry: 'DE', customerCurrency: 'EUR', customerOod: 'SAP', territory: 'DE01' },
    'CUST-US-002': { name: 'Parker Hannifin', tier: 'B', customerCountry: 'US', customerCurrency: 'USD', customerOod: 'SMA', territory: 'US10' },
    'CUST-CN-003': { name: 'Sany Heavy Industry', tier: 'A', customerCountry: 'CN', customerCurrency: 'CNY', customerOod: 'CN', territory: 'CN01' },
    'CUST-IN-004': { name: 'Tata Hitachi', tier: 'B', customerCountry: 'IN', customerCurrency: 'INR', customerOod: 'IN', territory: 'IN01' },
  };
  for (const [customerId, c] of Object.entries(customers)) add('party-config', customerId, versioned({ customerId, ...c }, '2026.08.0', 'ACTIVE', '2026-08-01', null, PUB));

  add('price-list', 'EU_SEALS', versioned({
    id: 'EU_SEALS', name: 'EU standard seals', currency: 'EUR', appliesWhen: { region: 'EUROPE', family: 'O-Rings' },
    dimensions: [{ attr: 'customer', label: 'Customer', weight: 100 }, { attr: 'tier', label: 'Tier', weight: 30 }, { attr: 'region', label: 'Region', weight: 20 }],
    rows: [
      { part: 'OR-25X3-NBR', match: {}, tiers: [{ from: 0, value: '1.20' }, { from: 500, value: '1.10' }, { from: 2000, value: '0.98' }], validFrom: '2026-01-01' },
      { part: 'OR-25X3-NBR', match: { tier: 'A' }, tiers: [{ from: 0, value: '1.08' }, { from: 500, value: '0.99' }], validFrom: '2026-01-01' },
      { part: 'OR-25X3-NBR', match: { customer: 'CUST-DE-001' }, tiers: [{ from: 0, value: '0.95' }], validFrom: '2026-07-01', validTo: '2026-12-31' },
      { part: 'OR-40X5-FKM', match: {}, tiers: [{ from: 0, value: '3.40' }, { from: 250, value: '3.10' }], validFrom: '2026-01-01' },
    ],
    discount: [{ match: { tier: 'A' }, value: '0.03' }, { match: {}, value: 0 }],
    constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', min: 100, mode: 'PRICE' }],
  }, '2026.09.1', 'ACTIVE', '2026-09-01', null, { ...PUB, note: 'Price list EU standard seals added (O-Rings)' }));

  add('catalog-book', 'PTFE_BEARINGS', versioned({
    id: 'PTFE_BEARINGS', name: 'PTFE slide bearings', currency: 'EUR', dsl_version: 1, appliesWhen: { family: 'PTFE bearings' }, matchOn: ['spec', 'variant'],
    rows: [{ match: { spec: '120', variant: 'standard' }, rate: '84.00' }, { match: { spec: '160', variant: 'standard' }, rate: '112.00' }, { match: { spec: '120', variant: 'FDA' }, rate: '96.00' }],
    fallbackFormula: 'diameter_mm * cost.ptfe_rate_per_mm + cost.machining_setup / quantity',
    costInputs: {
      ptfe_rate_per_mm: { value: '0.62', unit: 'EUR / mm Ø', validFrom: '2026-08-01', source: 'MANUAL' },
      machining_setup: [{ value: '150', unit: 'EUR / order', validFrom: '2026-01-01', validTo: '2026-06-01', source: 'MANUAL' }, { value: '180', unit: 'EUR / order', validFrom: '2026-06-01', source: 'MANUAL' }],
    },
    freight: 0, margin: [{ match: { tier: 'A' }, value: '0.18' }, { match: {}, value: '0.22' }], floor: '0.12', discount: [{ match: { tier: 'A' }, value: '0.02' }, { match: {}, value: 0 }],
  }, '2026.09.1', 'ACTIVE', '2026-09-01', null, { ...PUB, note: 'Catalog + formula book PTFE slide bearings added' }));

  add('routing-rules', '*', versioned({
    key: '*',
    rules: [
      { when: { family: 'O-Rings' }, type: 'PRICE_LIST', book: 'EU_SEALS' },
      { when: { family: 'PTFE bearings' }, type: 'CATALOG_FORMULA', book: 'PTFE_BEARINGS' },
    ],
  }, '2026.09.1', 'ACTIVE', '2026-09-01', null, { ...PUB, note: 'Routing: O-Rings → price list, PTFE bearings → catalog' }));

  return docs;
}

export const USERS = {
  alice: { id: 'alice', roles: ['PricingViewer'] },
  bob: { id: 'bob', roles: ['PricingViewer', 'PricingAdmin'] },
};
