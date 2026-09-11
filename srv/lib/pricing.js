const Decimal = require('decimal.js');
const { priceItems, TECHNIQUES } = require('@tss-pricing/engine-core');
const { store } = require('./store');
const { api6 } = require('./api6');

// Topic 8: kit/BOM header-cost-is-sum-of-components only has a real API6 path for Americas
// (JDE E1) and China (JDE) — Europe's BOM explosion is handled natively inside S4 (see the S4
// Pricing sheet), and India has no kit mechanism in the reference docs at all. A kit item
// requested for any other region is a typed MISSING, not a silent (wrong) price.
const KIT_SUPPORTED_REGIONS = ['AMERICAS', 'CHINA'];

const SUPPLIER_WAREHOUSE_ADDER_FIELDS = ['freight', 'duty', 'tariff'];
// MOQ is deliberately not here — it's a property of the order/part, not the supplier
// (owner: "MOQ is not based on the supplier, its based on the order"); the MIN_QTY
// constraint still reads it from the part's own facts, unaffected by this.
const SUPPLIER_WIDE_ADDER_FIELDS = ['molv'];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

class PricingRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Landed-cost adders/constraints that vary by supplier — independent of the cost access
 * sequence, which only picks WHICH cost candidate to use. A supplier is independent of
 * region (it manufactures in one country and ships to warehouses across regions), so
 * lookup is by supplier id alone. Resolved per line (an item's own `supplier`) and merged
 * over whatever API6 already put in facts.elements — a supplier-specific value wins where
 * set; anything it doesn't override keeps the API6/generic value.
 */
function applySupplierOverrides(facts, items, priceDate, suppliers) {
  for (const item of items) {
    if (!item.supplier) continue;
    const supplierConfig = suppliers(item.supplier, priceDate);
    if (!supplierConfig) continue;

    // Owner decision (2026-08-26, mockup review): Americas' LCA domestic/overseas split and
    // India's +40% key off the SUPPLIER's actual country, not the item's ood. An explicit
    // item.supplierCountry always wins (same precedence as everywhere else); otherwise it
    // resolves from supplier-config. Left unresolved, `when` conditions like
    // "item.supplierCountry !== 'US'" put the line in the OVERSEAS branch — the conservative
    // higher rate, never a silent under-price, and always visible in the trace.
    if (!item.supplierCountry && supplierConfig.supplierCountry) {
      item.supplierCountry = supplierConfig.supplierCountry;
    }

    const overrides = {};
    for (const field of SUPPLIER_WIDE_ADDER_FIELDS) {
      if (supplierConfig[field] !== undefined && supplierConfig[field] !== null) overrides[field] = supplierConfig[field];
    }

    // Freight/duty/tariff are per-destination-warehouse, not supplier-wide (owner: "supplier
    // is independent of the region... freight duty and tariff for specific warehouse") — a
    // line only gets them when it names BOTH a supplier and a warehouse that supplier ships
    // to; no warehouse (or a warehouse this supplier has no entry for) falls back to
    // whatever API6/generic facts already have, same as a supplier with no override at all.
    const warehouseTerms = item.warehouse && supplierConfig.warehouses?.[item.warehouse];
    if (warehouseTerms) {
      for (const field of SUPPLIER_WAREHOUSE_ADDER_FIELDS) {
        if (warehouseTerms[field] !== undefined && warehouseTerms[field] !== null) overrides[field] = warehouseTerms[field];
      }
    }

    if (Object.keys(overrides).length === 0) continue;
    facts.elements[item.partNumber] = { ...(facts.elements[item.partNumber] || {}), ...overrides };
  }
}

/**
 * Normalizes each item's raw ERP stock-class code (facts.classification[partNumber]
 * .stockClassRaw — e.g. China's OMT/SMT/CMT, Americas' MTS-Z/MTS-2C) into the canonical
 * item.stockClass ('MTS'|'NonMTS') engine-core's `when` conditions branch on, using this
 * region's config.stockClassMap. Mutates items in place, mirroring how item.supplierCountry
 * already arrives pre-resolved. A no-op for any region that hasn't declared a stockClassMap.
 *
 * Once a region does declare a map, every item must resolve to a mapped code or it comes
 * back MISSING(STOCK_CLASS_UNRESOLVED) from engine-core (via item.stockClassError) rather
 * than silently skipping stockClass-conditioned build-up elements — see kernel.js. Only
 * cost-plus lines ever reach the kernel, so a price-list or catalog part without an ERP
 * stock class is unaffected.
 */
function applyStockClassNormalization(facts, items, config) {
  if (!config.stockClassMap) return;
  for (const item of items) {
    // Explicit selection always wins, same precedence as cost candidates, supplier country,
    // and region — a caller that already knows the stock class skips ERP-code normalization.
    if (item.stockClass) continue;
    const raw = facts.classification && facts.classification[item.partNumber] && facts.classification[item.partNumber].stockClassRaw;
    if (raw === undefined || raw === null || raw === '') {
      item.stockClassError = 'STOCK_CLASS_NOT_PROVIDED';
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(config.stockClassMap, raw)) {
      item.stockClass = config.stockClassMap[raw];
    } else {
      item.stockClassError = `STOCK_CLASS_UNMAPPED:${raw}`;
    }
  }
}

/**
 * In production a host system (C4C) resolves an item's own master-data attributes —
 * supplier, warehouse, supplier country — before it ever calls this pricing API, and sends
 * them already populated in the request. `facts.itemAttributes` (from API6's recorded
 * payloads, standing in for that C4C resolution in dev/test) fills in only what the caller
 * left unset — never overriding a value the request already supplied.
 */
function applyItemAttributesFromFacts(facts, items) {
  for (const item of items) {
    const attrs = facts.itemAttributes && facts.itemAttributes[item.partNumber];
    if (!attrs) continue;
    if (!item.supplier && attrs.supplier) item.supplier = attrs.supplier;
    if (!item.supplierCountry && attrs.supplierCountry) item.supplierCountry = attrs.supplierCountry;
    if (!item.warehouse && attrs.warehouse) item.warehouse = attrs.warehouse;
  }
}

/**
 * The Additional Cost flag (topic 10): a line-level selector the host UI exposes ("0 -
 * Nothing to add" ... "4 - Landed cost & Markup, No tariff") that picks which build-up
 * elements apply for that one line. Resolved through this region's config.additionalCostMap
 * into item.includeMarkup/includeLandedCost/includeTariff/includePick, which buildUp `when`
 * clauses read via `!== false`. Never setting the flag is NOT an error (every element still
 * applies); only an explicitly-set but unrecognized value is a typed MISSING.
 */
function applyAdditionalCostFlags(items, config) {
  if (!config.additionalCostMap) return;
  for (const item of items) {
    if (item.additionalCost === undefined || item.additionalCost === null) continue;
    const mapping = config.additionalCostMap[String(item.additionalCost)];
    if (!mapping) {
      item.additionalCostError = `ADDITIONAL_COST_UNMAPPED:${item.additionalCost}`;
      continue;
    }
    item.includeMarkup = mapping.markup;
    item.includeLandedCost = mapping.landedCost;
    item.includeTariff = mapping.tariff;
    item.includePick = mapping.pick;
  }
}

/**
 * Trelleborg's supplier quantity-break table (topic 7): a supplier COST that varies by
 * quantity break — per the owner a supplier cost, not the customer sell price, so it feeds
 * the normal landed-cost build-up afterward like any other cost candidate (and stays inside
 * cost plus in v2 — ARCHITECTURE_V2 §0 item 6; the price-list TECHNIQUE is a different thing).
 *
 * facts.qtyBreaks[partNumber] is that table. Any part carrying one gets its cost tier picked
 * by the actual requested quantity; the Americas MROQ standalone flow (item.mroqOverride,
 * only meaningful when item.ood === 'SMA') previews a hypothetical quantity instead. Either
 * way the matching tier is added as a cost candidate and selected via item.selectedCostId —
 * engine-core's existing "an explicit selection always wins" precedence. An item that already
 * carries its own selectedCostId is left alone.
 */
function applyQuantityBreakCost(facts, items) {
  if (!facts.qtyBreaks) return;
  for (const item of items) {
    if (item.selectedCostId) continue;
    const breaks = facts.qtyBreaks[item.partNumber];
    if (!breaks || breaks.length === 0) continue;

    const isMroqOverride = !!item.mroqOverride && item.ood === 'SMA';
    const requestedQty = Number(isMroqOverride ? item.mroqOverride : item.quantity);
    if (!Number.isFinite(requestedQty) || requestedQty <= 0) continue;

    const applicable = [...breaks]
      .filter((b) => Number(b.minQty) <= requestedQty)
      .sort((a, b) => Number(b.minQty) - Number(a.minQty))[0];
    if (!applicable) continue;

    const existing = facts.costs[item.partNumber] || { default: null, candidates: [] };
    const candidateKey = `${isMroqOverride ? 'MROQ_OVERRIDE' : 'QTY_BREAK'}_${item.partNumber}_${applicable.minQty}`;
    facts.costs[item.partNumber] = {
      ...existing,
      candidates: [
        ...existing.candidates,
        {
          value: applicable.value,
          currency: applicable.currency || existing.candidates[0]?.currency || 'USD',
          basis: 'SUPPLIER_CATALOG',
          source: { system: 'JDE_E1', table: 'F41291', field: 'QTY_BREAK', key: candidateKey },
          validFrom: applicable.validFrom || null,
          retrievedAt: applicable.retrievedAt || null,
          confidence: 'EXACT',
        },
      ],
    };
    item.selectedCostId = candidateKey;
  }
}

// ---- config resolution -----------------------------------------------------------------

/**
 * Everything engine-core needs as-of the price date: the region config, every effective
 * price list and catalog, and the routing rules (ARCHITECTURE_V2 §2.1). `overrides` lets
 * `simulate` substitute a DRAFT for the live document of the same (kind, key) — or add a
 * book that does not exist live yet — without the store ever seeing it.
 */
function resolveConfig({ region, salesOrg, priceDate, overrides = {} }) {
  const pick = (kind, key, live) => (overrides[`${kind}|${key}`] ? overrides[`${kind}|${key}`] : live);
  const regionKey = `${region}::${salesOrg}`;
  const liveRegion = store.getEffective('region-config', regionKey, priceDate);
  const regionDoc = overrides[`region-config|${regionKey}`] || (liveRegion ? pick('region-config', `${liveRegion.region}::${liveRegion.salesOrg}`, liveRegion) : null);
  if (!regionDoc) return null;

  const books = (kind) => {
    const out = {};
    for (const [id, doc] of Object.entries(store.listEffective(kind, priceDate))) out[id] = pick(kind, id, doc);
    for (const [k, doc] of Object.entries(overrides)) {
      const [oKind, oKey] = k.split('|');
      if (oKind === kind && !out[oKey]) out[oKey] = doc;
    }
    return out;
  };
  const priceLists = books('price-list');
  const catalogs = books('catalog-book');
  const routing = pick('routing-rules', '*', store.getEffective('routing-rules', '*', priceDate)) || { rules: [] };

  return {
    region: regionDoc,
    priceLists,
    catalogs,
    routing,
    suppliers: (supplier, date) => pick('supplier-config', supplier, store.getEffectiveSupplierConfig(supplier, date)),
    party: (customerId, date) => (customerId ? pick('party-config', customerId, store.getEffectivePartyConfig(customerId, date)) : null),
    route: (ood, so, date) => {
      const live = store.getEffectiveRegionRoute(ood, so, date);
      return overrides[`region-route|${ood}::${so}`] || (live ? pick('region-route', `${live.ood}::${live.salesOrg}`, live) : null);
    },
  };
}

function versionsOf(config) {
  const bookVersions = (books) => Object.fromEntries(Object.entries(books).map(([id, b]) => [id, { version: b.version, status: b.status }]));
  return {
    region: config.region.region,
    salesOrg: config.region.salesOrg,
    version: config.region.version,
    status: config.region.status,
    books: { ...bookVersions(config.priceLists), ...bookVersions(config.catalogs) },
    routing: config.routing.version ? { version: config.routing.version, status: config.routing.status } : null,
  };
}

/**
 * Real host systems (e.g. C4C) don't send our internal region code at all — they send a
 * customer's Origin of Data + salesOrg, and region-route config resolves that to a region.
 * `payload.region` still wins whenever the caller supplies it explicitly. Never a silent
 * guess: an unresolvable (ood, salesOrg) is a typed error, and a resolved region always says
 * how it got there (`region.derivedBy`), mirroring `costCandidate.selectedBy`.
 */
function resolveRegion({ region, salesOrg, customerOod, priceDate, route }) {
  if (region) return { region, derivedBy: 'EXPLICIT' };
  if (!customerOod) return { region: null, derivedBy: null, reason: 'NO_REGION_OR_CUSTOMER_OOD' };
  const r = route(customerOod, salesOrg, priceDate);
  if (!r) return { region: null, derivedBy: null, reason: 'NO_MATCHING_REGION_ROUTE' };
  return { region: r.region, derivedBy: `ROUTE:${customerOod}`, entityLabel: r.entityLabel };
}

// ---- the pipeline ------------------------------------------------------------------------

/** Accepts both the neutral §7 shape (`context`, `party`) and the flat legacy fields. */
function normalizePayload(payload) {
  const context = payload.context || {};
  const party = payload.party || {};
  return {
    region: payload.region || party.region || null,
    salesOrg: payload.salesOrg || party.salesOrg || '*',
    purpose: payload.purpose || context.purpose || 'INDICATIVE',
    hostSystem: payload.hostSystem || context.hostSystem || 'API',
    hostObjectType: payload.hostObjectType || context.hostObjectType || 'QUOTE',
    hostObjectId: payload.hostObjectId || context.hostObjectId || null,
    customerId: payload.customerId || party.customerId || null,
    customerOod: payload.customerOod || party.ood || null,
    priceDate: payload.priceDate || todayIso(),
    instructions: payload.instructions,
    items: payload.items,
  };
}

/** Region + party + config resolution shared by price / fetchItemAttributes / simulate. */
function resolveScope(payload, { overrides } = {}) {
  const p = normalizePayload(payload);
  if (!Array.isArray(p.items) || p.items.length === 0) throw new PricingRequestError(400, 'payload.items must be a non-empty array.');

  const lookups = probeLookups(overrides);
  const partyConfig = lookups.party(p.customerId, p.priceDate);
  const customerOod = p.customerOod || (partyConfig && partyConfig.customerOod) || null;

  const resolved = resolveRegion({ region: p.region, salesOrg: p.salesOrg, customerOod, priceDate: p.priceDate, route: lookups.route });
  if (!resolved.region) {
    throw new PricingRequestError(400, `payload.region is required (or provide customerId/customerOod that resolves via region-route) — ${resolved.reason}.`);
  }
  const config = resolveConfig({ region: resolved.region, salesOrg: p.salesOrg, priceDate: p.priceDate, overrides });
  if (!config) throw new PricingRequestError(422, `No effective config for region "${resolved.region}" / salesOrg "${p.salesOrg}" as of ${p.priceDate}.`);

  return { ...p, region: resolved.region, regionInfo: { value: resolved.region, derivedBy: resolved.derivedBy, entityLabel: resolved.entityLabel || null }, customerOod, partyConfig, config };
}

// Party and route are looked up BEFORE the region is known, so they get their own
// override-aware closures rather than living on the resolved config.
function probeLookups(overrides = {}) {
  return {
    party: (customerId, date) => (customerId ? overrides[`party-config|${customerId}`] || store.getEffectivePartyConfig(customerId, date) : null),
    route: (ood, so, date) => {
      const live = store.getEffectiveRegionRoute(ood, so, date);
      return overrides[`region-route|${ood}::${so}`] || (live ? overrides[`region-route|${live.ood}::${live.salesOrg}`] || live : null);
    },
  };
}

function neutralRequest(scope, items) {
  const pc = scope.partyConfig;
  return {
    context: { hostSystem: scope.hostSystem, hostObjectType: scope.hostObjectType, hostObjectId: scope.hostObjectId, purpose: scope.purpose },
    party: {
      customerId: scope.customerId,
      salesOrg: scope.salesOrg,
      region: scope.region,
      ood: scope.customerOod,
      tier: pc ? pc.tier || null : null,
      segment: pc ? pc.segment || null : null,
      territory: pc ? pc.territory : null,
      country: pc ? pc.customerCountry : null,
      currency: pc ? pc.customerCurrency : null,
    },
    items,
    priceDate: scope.priceDate,
    instructions: scope.instructions,
  };
}

/**
 * Prices one payload: resolves scope + facts, runs every normalization pass, prices
 * non-kit items and kit components in ONE priceItems() call, then folds kits. Returns the
 * `price` response body minus documentId (the handler stores the document and adds it).
 */
async function pricePayload(payload, { overrides } = {}) {
  const scope = resolveScope(payload, { overrides });
  const items = scope.items.map((it) => ({ ...it, components: Array.isArray(it.components) ? it.components.map((c) => ({ ...c })) : it.components }));

  // Kit components need their own facts too (they're priced as full lines in their own
  // right), so fetch for every part number that will actually be priced.
  const allParts = items.flatMap((it) => (Array.isArray(it.components) ? it.components : [it]));
  const facts = await api6.getPricingFacts({ region: scope.region, salesOrg: scope.salesOrg, items: allParts });

  const request = neutralRequest(scope, items);
  const result = priceWithKits({ region: scope.region, priceDate: scope.priceDate, facts, config: scope.config, request });

  return {
    config: versionsOf(scope.config),
    region: scope.regionInfo,
    priceDate: scope.priceDate,
    purpose: scope.purpose,
    party: request.party,
    ...result,
  };
}

/**
 * Kit/BOM (topic 8): a kit header item (item.components: [{partNumber, quantity, ...}]) is
 * quoted as ONE line, priced as Σ component unitPrice × quantity — each component through its
 * own full pipeline (its own supplier, stock class, technique). Every component across every
 * kit is flattened into one batch alongside the regular items so fact resolution and a single
 * priceItems() call cover them identically. v2: a component that routes to a non-cost-plus
 * technique is KIT_COMPONENT_UNRESOLVED — a kit is a cost-plus construct, its header margin
 * would otherwise double-count a component that already is a sell price.
 */
function priceWithKits({ region, priceDate, facts, config, request }) {
  const items = request.items;
  const kitIndices = [];
  items.forEach((it, i) => {
    if (Array.isArray(it.components) && it.components.length > 0) kitIndices.push(i);
  });

  const nonKitItems = items.filter((_, i) => !kitIndices.includes(i));
  const componentItems = [];
  const componentOwner = [];
  for (const kitIndex of kitIndices) {
    for (const comp of items[kitIndex].components) {
      componentItems.push(comp);
      componentOwner.push(kitIndex);
    }
  }

  const flatItems = [...nonKitItems, ...componentItems];
  applySupplierOverrides(facts, flatItems, priceDate, config.suppliers);
  applyStockClassNormalization(facts, flatItems, config.region);
  applyAdditionalCostFlags(flatItems, config.region);
  applyQuantityBreakCost(facts, flatItems);

  const flatResult = flatItems.length ? priceItems({ request: { ...request, items: flatItems }, facts, config }) : { items: [] };
  const nonKitLines = flatResult.items.slice(0, nonKitItems.length);
  const componentLines = flatResult.items.slice(nonKitItems.length);

  const kitLines = kitIndices.map((kitIndex) => kitLine(items[kitIndex], region, componentLines.filter((_, i) => componentOwner[i] === kitIndex)));

  const merged = [];
  let nonKitCursor = 0;
  let kitCursor = 0;
  for (let i = 0; i < items.length; i++) merged.push(kitIndices.includes(i) ? kitLines[kitCursor++] : nonKitLines[nonKitCursor++]);
  return { items: merged };
}

function kitLine(kitItem, region, componentLines) {
  const base = { partNumber: kitItem.partNumber, technique: TECHNIQUES.COST_PLUS, book: null, routedBy: 'DEFAULT' };
  const missing = (status, m) => ({ ...base, status, missing: m, flags: [{ level: 'crit', code: m.reason, text: m.reason }], trace: { technique: TECHNIQUES.COST_PLUS, kit: true, components: componentLines, steps: [] } });

  if (!KIT_SUPPORTED_REGIONS.includes(region)) return missing('MISSING', { reason: 'KIT_NOT_SUPPORTED_FOR_REGION', region, supportedRegions: KIT_SUPPORTED_REGIONS });

  const failed = componentLines.find((l) => l.status !== 'PRICED');
  if (failed) return missing(failed.status, { reason: 'KIT_COMPONENT_UNRESOLVED', componentPartNumber: failed.partNumber, componentIssue: failed.missing });

  const foreign = componentLines.find((l) => l.technique !== TECHNIQUES.COST_PLUS);
  if (foreign) {
    return missing('MISSING', { reason: 'KIT_COMPONENT_UNRESOLVED', componentPartNumber: foreign.partNumber, componentIssue: { reason: 'KIT_COMPONENT_NOT_COST_PLUS', technique: foreign.technique, book: foreign.book } });
  }

  const currencies = [...new Set(componentLines.map((l) => l.result.currency))];
  if (currencies.length > 1) return missing('MISSING', { reason: 'KIT_CURRENCY_MISMATCH', currencies });

  const sum = (field) => componentLines.reduce((acc, l) => acc.plus(new Decimal(l.result[field]).times(l.result.quantity)), new Decimal(0));
  return {
    ...base,
    status: 'PRICED',
    result: { unitPrice: sum('unitPrice').toString(), landedCost: sum('landedCost').toString(), margin: null, currency: currencies[0], quantity: kitItem.quantity },
    flags: componentLines.flatMap((l) => (l.flags || []).map((f) => ({ ...f, component: l.partNumber }))),
    trace: { technique: TECHNIQUES.COST_PLUS, kit: true, components: componentLines, steps: [] },
  };
}

/**
 * fetchItemAttributes: the C4C-style "resolve the line's attributes before pricing" step —
 * supplier / supplier country / warehouse / stock class from master data, and (v2) the
 * product attributes routing and the books read (family, spec, variant, numeric attributes).
 * A pure preview: nothing is priced.
 */
async function fetchItemAttributes(payload) {
  const scope = resolveScope(payload);
  const facts = await api6.getPricingFacts({ region: scope.region, salesOrg: scope.salesOrg, items: scope.items });
  const workingItems = scope.items.map((it) => ({ ...it }));
  applyItemAttributesFromFacts(facts, workingItems);
  applySupplierOverrides(facts, workingItems, scope.priceDate, scope.config.suppliers);
  applyStockClassNormalization(facts, workingItems, scope.config.region);

  const attributes = {};
  for (const item of workingItems) {
    const product = (facts.items && facts.items[item.partNumber]) || {};
    attributes[item.partNumber] = {
      supplier: item.supplier || null,
      supplierCountry: item.supplierCountry || null,
      warehouse: item.warehouse || null,
      stockClass: item.stockClass || null,
      stockClassError: item.stockClassError || null,
      product,
    };
  }
  return { region: scope.regionInfo, priceDate: scope.priceDate, attributes };
}

module.exports = {
  pricePayload,
  fetchItemAttributes,
  resolveConfig,
  resolveScope,
  normalizePayload,
  priceWithKits,
  PricingRequestError,
  KIT_SUPPORTED_REGIONS,
  todayIso,
};
