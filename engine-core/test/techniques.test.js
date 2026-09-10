const { test } = require('node:test');
const assert = require('node:assert/strict');
const { priceItems, resolveTechnique, TECHNIQUES } = require('../src');

const PROV = { source: 'HUMAN', authoredAt: '2026-08-01T00:00:00Z' };

// Region: the real EUROPE build-up (seed.js) with a sell margin — the same numbers every
// existing kernel test pins, plus the v2 sell price on top.
const EUROPE = {
  region: 'EUROPE', salesOrg: '*', version: '2026.09.1', status: 'ACTIVE', validFrom: '2026-09-01', validTo: null,
  resolution: [], provenance: PROV,
  costAccessSequence: { NonMTS: ['CCD', 'C4C', 'ERP', 'CCP'], '*': ['C4C', 'ERP', 'CCD', 'CCP'] },
  buildUp: [
    { id: 'BASE_COST', type: 'BASE', provenance: PROV },
    { id: 'SCM_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.047, when: 'item.includeMarkup !== false', provenance: PROV },
    { id: 'FREIGHT', type: 'FACTOR', basis: ['BASE_COST', 'SCM_MARKUP'], rateRef: 'freight', when: ["item.stockClass === 'NonMTS'", 'item.includeLandedCost !== false'], provenance: PROV },
    { id: 'DUTY', type: 'FACTOR', basis: ['BASE_COST', 'SCM_MARKUP'], rateRef: 'duty', when: ["item.stockClass === 'NonMTS'", 'item.includeLandedCost !== false'], provenance: PROV },
    { id: 'TARIFF', type: 'FACTOR', basis: ['BASE_COST', 'SCM_MARKUP'], rateRef: 'tariff', when: 'item.includeTariff !== false', provenance: PROV },
    { id: 'PICK_CHARGE', type: 'PER_LINE', amountRef: 'pickCharge', when: 'item.includePick !== false', provenance: PROV },
  ],
  constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv', provenance: PROV }, { id: 'MOQ', type: 'CONSTRAINT', kind: 'MIN_QTY', minRef: 'moq', provenance: PROV }],
  rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
  sell: { defaultMargin: 0.30 },
};

const EU_SEALS = {
  id: 'EU_SEALS', name: 'EU standard seals', version: '2026.09.1', currency: 'EUR',
  appliesWhen: { region: 'EUROPE', family: 'O-Rings' },
  dimensions: [{ attr: 'customer', label: 'Customer', weight: 100 }, { attr: 'tier', label: 'Tier', weight: 30 }, { attr: 'region', label: 'Region', weight: 20 }],
  rows: [
    { part: 'OR-25X3-NBR', match: {}, tiers: [{ from: 0, value: '1.20' }, { from: 500, value: '1.10' }, { from: 2000, value: '0.98' }], validFrom: '2026-01-01' },
    { part: 'OR-25X3-NBR', match: { tier: 'A' }, tiers: [{ from: 0, value: '1.08' }, { from: 500, value: '0.99' }], validFrom: '2026-01-01' },
    { part: 'OR-25X3-NBR', match: { customer: 'CUST-DE-001' }, tiers: [{ from: 0, value: '0.95' }], validFrom: '2026-07-01', validTo: '2026-12-31' },
  ],
  discount: [{ match: { tier: 'A' }, value: '0.03' }, { match: {}, value: 0 }],
  constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', min: 100, mode: 'PRICE', provenance: PROV }],
};

const PTFE = {
  id: 'PTFE_BEARINGS', name: 'PTFE slide bearings', version: '2026.09.1', currency: 'EUR', dsl_version: 1,
  appliesWhen: { family: 'PTFE bearings' },
  matchOn: ['spec', 'variant'],
  rows: [{ match: { spec: '120', variant: 'standard' }, rate: '84.00' }, { match: { spec: '160', variant: 'standard' }, rate: '112.00' }],
  fallbackFormula: 'diameter_mm * cost.ptfe_rate_per_mm + cost.machining_setup / quantity',
  costInputs: {
    ptfe_rate_per_mm: { value: '0.62', unit: 'EUR / mm', validFrom: '2026-08-01', source: 'MANUAL' },
    machining_setup: [{ value: '150', validFrom: '2026-01-01', validTo: '2026-06-01', source: 'MANUAL' }, { value: '180', validFrom: '2026-06-01', source: 'MANUAL' }],
  },
  freight: 0,
  margin: [{ match: { tier: 'A' }, value: '0.18' }, { match: {}, value: '0.22' }],
  floor: '0.12',
  discount: [{ match: { tier: 'A' }, value: '0.02' }, { match: {}, value: 0 }],
};

const CONFIG = { region: EUROPE, priceLists: { EU_SEALS }, catalogs: { PTFE_BEARINGS: PTFE }, routing: { rules: [{ when: { family: 'O-Rings' }, type: 'PRICE_LIST', book: 'EU_SEALS' }, { when: { family: 'PTFE bearings' }, type: 'CATALOG_FORMULA', book: 'PTFE_BEARINGS' }] } };

const cost = (value, system, currency = 'EUR') => ({ value, currency, basis: 'MOVING_AVG', source: { system, table: 'T', field: 'F', key: `${system}_1` }, validFrom: '2026-08-01', retrievedAt: '2026-08-20T00:00:00Z', confidence: 'EXACT' });
const FACTS = {
  costs: { 'P-10023': { default: 'ERP_1', candidates: [cost('100.00', 'ERP')] }, 'EU-T100': { default: 'CCD_1', candidates: [cost('100.00', 'CCD')] } },
  elements: { 'P-10023': { freight: '0.05', duty: '0.02', tariff: '0', pickCharge: '21.00', molv: '50.00', moq: '1' }, 'EU-T100': { freight: '0.1', duty: '0.05', tariff: '0.08', pickCharge: '20.00', molv: '50.00', moq: '1' } },
  items: {
    'P-10023': { family: 'Hydraulic seals' },
    'EU-T100': { family: 'Hydraulic seals' },
    'OR-25X3-NBR': { family: 'O-Rings', spec: '25x3', variant: 'NBR70' },
    'PTFE-BRG-120': { family: 'PTFE bearings', spec: '120', variant: 'standard', diameter_mm: 120 },
    'PTFE-BRG-137': { family: 'PTFE bearings', spec: '137', variant: 'custom', diameter_mm: 137 },
  },
  fx: {},
};
const request = (items, party = { customerId: 'CUST-DE-001', tier: 'A', salesOrg: 'DE01' }, priceDate = '2026-09-10') => ({
  context: { hostSystem: 'API', hostObjectType: 'QUOTE', purpose: 'INDICATIVE' }, party, items, priceDate,
});

test('cost plus: landed cost unchanged from the kernel, sell price = landed / (1 - region margin)', () => {
  const { items } = priceItems({ request: request([{ partNumber: 'P-10023', quantity: 10, stockClass: 'MTS' }]), facts: FACTS, config: CONFIG });
  const [l] = items;
  assert.equal(l.technique, 'COST_PLUS');
  assert.equal(l.routedBy, 'DEFAULT');
  assert.equal(l.result.landedCost, '106.8'); // 100 + 4.7 + 21/10
  assert.equal(l.result.margin, '0.3');
  assert.equal(l.result.unitPrice, '152.57'); // 106.8 / 0.7 = 152.5714...
  assert.equal(l.trace.sell.source, 'REGION_DEFAULT');
  assert.deepEqual(l.flags, []);
});

test('cost plus: a line margin override wins over the region default and is named in the trace', () => {
  const { items } = priceItems({ request: request([{ partNumber: 'P-10023', quantity: 10, stockClass: 'MTS', marginOverride: '0.25' }]), facts: FACTS, config: CONFIG });
  assert.equal(items[0].result.unitPrice, '142.4');
  assert.equal(items[0].trace.sell.source, 'LINE_OVERRIDE');
});

test('cost plus: a region without a sell section prices unitPrice = landedCost (pre-v2 behaviour)', () => {
  const { sell, ...noSell } = EUROPE;
  const { items } = priceItems({ request: request([{ partNumber: 'P-10023', quantity: 10, stockClass: 'MTS' }]), facts: FACTS, config: { ...CONFIG, region: noSell } });
  assert.equal(items[0].result.unitPrice, '106.8');
  assert.equal(items[0].result.margin, null);
});

test('cost plus: an invalid margin is a typed MISSING, not a division by zero', () => {
  const { items } = priceItems({ request: request([{ partNumber: 'P-10023', quantity: 10, stockClass: 'MTS', marginOverride: 1 }]), facts: FACTS, config: CONFIG });
  assert.equal(items[0].status, 'MISSING');
  assert.equal(items[0].missing.reason, 'MARGIN_INVALID');
});

test('price list: the customer-specific row beats the tier row, discount applies, order rules run', () => {
  const { items } = priceItems({ request: request([{ partNumber: 'OR-25X3-NBR', quantity: 500 }]), facts: FACTS, config: CONFIG });
  const [l] = items;
  assert.equal(l.technique, 'PRICE_LIST');
  assert.equal(l.book, 'EU_SEALS');
  assert.equal(l.routedBy, 'RULE:0');
  assert.equal(l.result.unitPrice, '0.92'); // 0.95 * 0.97 = 0.9215
  assert.equal(l.result.landedCost, null);
  assert.equal(l.trace.resolution.candidates.filter((c) => c.won).length, 1);
  assert.equal(l.trace.resolution.candidates.find((c) => c.won).description, 'customer = CUST-DE-001');
  assert.ok(l.flags.some((f) => f.code === 'ROW_EXPIRES'));
});

test('price list: a tier-B customer gets the default row and the quantity tier; MOLV raises the unit price', () => {
  const partyB = { customerId: 'CUST-DE-007', tier: 'B', salesOrg: 'DE01' };
  const big = priceItems({ request: request([{ partNumber: 'OR-25X3-NBR', quantity: 600 }], partyB), facts: FACTS, config: CONFIG }).items[0];
  assert.equal(big.result.unitPrice, '1.1');
  assert.equal(big.trace.steps.find((s) => s.id === 'CUST_DISC').note.skipped, true);
  const small = priceItems({ request: request([{ partNumber: 'OR-25X3-NBR', quantity: 10 }], partyB), facts: FACTS, config: CONFIG }).items[0];
  assert.equal(small.result.unitPrice, '10'); // 1.20 * 10 = 12 < MOLV 100 -> 100 / 10
  assert.ok(small.flags.some((f) => f.code === 'MOLV_APPLIED'));
});

test('price list: after the customer row expires, the tier row applies — effective dating on rows', () => {
  const l = priceItems({ request: request([{ partNumber: 'OR-25X3-NBR', quantity: 500 }], undefined, '2027-01-10'), facts: FACTS, config: CONFIG }).items[0];
  assert.equal(l.trace.resolution.candidates.find((c) => c.won).description, 'tier = A');
  assert.equal(l.result.unitPrice, '0.96'); // 0.99 * 0.97 = 0.9603
});

test('price list: a part with no row is MISSING, not zero', () => {
  const cfg = { ...CONFIG, routing: { rules: [{ when: { family: 'Hydraulic seals' }, type: 'PRICE_LIST', book: 'EU_SEALS' }] } };
  const facts = { ...FACTS, items: { ...FACTS.items, 'P-10023': { family: 'Hydraulic seals' } } };
  const cfg2 = { ...cfg, priceLists: { EU_SEALS: { ...EU_SEALS, appliesWhen: { region: 'EUROPE' } } } };
  const l = priceItems({ request: request([{ partNumber: 'P-10023', quantity: 1 }]), facts, config: cfg2 }).items[0];
  assert.equal(l.status, 'MISSING');
  assert.equal(l.missing.reason, 'NO_LIST_PRICE');
});

test('catalog: an exact spec match is a sell price — margin is skipped with a reason, discount still applies', () => {
  const l = priceItems({ request: request([{ partNumber: 'PTFE-BRG-120', quantity: 4 }]), facts: FACTS, config: CONFIG }).items[0];
  assert.equal(l.technique, 'CATALOG_FORMULA');
  assert.equal(l.trace.source, 'CATALOG');
  assert.equal(l.result.unitPrice, '82.32'); // 84 * 0.98
  assert.equal(l.result.landedCost, null);
  assert.equal(l.trace.steps.find((s) => s.id === 'MARGIN').note.reason, 'CATALOG_RATE_IS_SELL_PRICE');
});

test('catalog: no row -> formula builds a cost from the line and the cost inputs in force, then margin, discount, floor check', () => {
  const l = priceItems({ request: request([{ partNumber: 'PTFE-BRG-137', quantity: 2 }]), facts: FACTS, config: CONFIG }).items[0];
  assert.equal(l.trace.source, 'FORMULA');
  assert.equal(l.trace.formula.value, '174.94'); // 137 * 0.62 + 180 / 2
  assert.equal(l.trace.costInputs['cost.machining_setup'].value, '180'); // the version in force since 2026-06-01, not 150
  assert.equal(l.result.landedCost, '174.94');
  assert.equal(l.result.unitPrice, '202.3'); // 174.94 * 1.18 * 0.98 = 202.300616
  assert.equal(l.trace.floor.breached, false);
  assert.ok(l.flags.some((f) => f.code === 'PRICED_BY_FORMULA'));
});

test('catalog: the cost input in force follows the price date', () => {
  const l = priceItems({ request: request([{ partNumber: 'PTFE-BRG-137', quantity: 2 }], undefined, '2026-03-01'), facts: FACTS, config: CONFIG }).items[0];
  // ptfe_rate_per_mm only valid from 2026-08-01 -> not in force on 2026-03-01
  assert.equal(l.status, 'MISSING');
  assert.equal(l.missing.reason, 'COST_INPUT_NOT_IN_FORCE');
  assert.equal(l.trace.variable, 'cost.ptfe_rate_per_mm');
});

test('catalog: a margin below the floor after discount is a crit flag, never silently accepted', () => {
  const book = { ...PTFE, margin: [{ match: {}, value: '0.10' }], discount: [{ match: {}, value: '0.05' }] };
  const l = priceItems({ request: request([{ partNumber: 'PTFE-BRG-137', quantity: 2 }]), facts: FACTS, config: { ...CONFIG, catalogs: { PTFE_BEARINGS: book } } }).items[0];
  assert.equal(l.status, 'PRICED');
  assert.equal(l.trace.floor.breached, true);
  assert.ok(l.flags.some((f) => f.code === 'MARGIN_FLOOR' && f.level === 'crit'));
});

test('catalog: a formula needing a line attribute the part does not carry is MISSING with the variable named', () => {
  const facts = { ...FACTS, items: { ...FACTS.items, 'PTFE-BRG-137': { family: 'PTFE bearings', spec: '137', variant: 'custom' } } };
  const l = priceItems({ request: request([{ partNumber: 'PTFE-BRG-137', quantity: 2 }]), facts, config: CONFIG }).items[0];
  assert.equal(l.missing.reason, 'FORMULA_INPUT_MISSING');
  assert.equal(l.trace.variable, 'diameter_mm');
});

test('catalog: a BINDING request refuses an AI-derived cost input; INDICATIVE prices it with a warning', () => {
  const book = { ...PTFE, costInputs: { ...PTFE.costInputs, ptfe_rate_per_mm: { value: '0.62', validFrom: '2026-08-01', source: 'AI_DERIVED' } } };
  const cfg = { ...CONFIG, catalogs: { PTFE_BEARINGS: book } };
  const indicative = priceItems({ request: request([{ partNumber: 'PTFE-BRG-137', quantity: 2 }]), facts: FACTS, config: cfg }).items[0];
  assert.equal(indicative.status, 'PRICED');
  assert.ok(indicative.flags.some((f) => f.code === 'COST_INPUT_CONFIDENCE'));
  const req = request([{ partNumber: 'PTFE-BRG-137', quantity: 2 }]);
  req.context.purpose = 'BINDING';
  const binding = priceItems({ request: req, facts: FACTS, config: cfg }).items[0];
  assert.equal(binding.status, 'BLOCKED');
});

test('routing: the user can force a technique per line; a book whose scope does not fit the region is skipped', () => {
  const forced = priceItems({ request: request([{ partNumber: 'OR-25X3-NBR', quantity: 500, pricingType: 'COST_PLUS' }]), facts: { ...FACTS, costs: { ...FACTS.costs, 'OR-25X3-NBR': { default: 'ERP_1', candidates: [cost('0.40', 'ERP')] } }, elements: { ...FACTS.elements, 'OR-25X3-NBR': { pickCharge: '21', molv: '0', moq: '1' } } }, config: CONFIG }).items[0];
  assert.equal(forced.technique, 'COST_PLUS');
  assert.equal(forced.routedBy, 'USER');
  const china = resolveTechnique({ partNumber: 'OR-25X3-NBR', quantity: 1 }, FACTS.items['OR-25X3-NBR'], CONFIG, { region: 'CHINA' });
  assert.deepEqual(china, { technique: TECHNIQUES.COST_PLUS, book: null, routedBy: 'DEFAULT' });
});

test('every line, whichever technique, carries the same result shape and a trace with steps', () => {
  const { items } = priceItems({ request: request([{ partNumber: 'EU-T100', quantity: 10, stockClass: 'NonMTS' }, { partNumber: 'OR-25X3-NBR', quantity: 500 }, { partNumber: 'PTFE-BRG-137', quantity: 2 }]), facts: FACTS, config: CONFIG });
  for (const l of items) {
    assert.equal(l.status, 'PRICED');
    assert.deepEqual(Object.keys(l.result).sort(), ['currency', 'landedCost', 'margin', 'quantity', 'unitPrice']);
    assert.ok(Array.isArray(l.trace.steps) && l.trace.steps.length > 0);
    assert.ok(Array.isArray(l.flags));
    assert.equal(l.trace.priceDate, '2026-09-10');
  }
  assert.equal(items[0].result.landedCost, '130.78'); // EU-T100 verification value (4.7% markup; 10/5/8% on 104.7; +2 pick)
  assert.equal(items[0].result.unitPrice, '186.83'); // 130.78 / 0.7
});
