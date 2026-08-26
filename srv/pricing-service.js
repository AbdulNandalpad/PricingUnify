const Decimal = require('decimal.js');
const { price } = require('@tss-pricing/engine-core');
const { store } = require('./lib/store');
const { api6 } = require('./lib/api6');

// Topic 8: kit/BOM header-cost-is-sum-of-components only has a real API6 path for Americas
// (JDE E1) and China (JDE) — Europe's BOM explosion is handled natively inside S4 (see the S4
// Pricing sheet), and India has no kit mechanism in the reference docs at all. A kit item
// requested for any other region is a typed MISSING, not a silent (wrong) price.
const KIT_SUPPORTED_REGIONS = ['AMERICAS', 'CHINA'];

const SUPPLIER_WAREHOUSE_ADDER_FIELDS = ['freight', 'duty', 'tariff'];
const SUPPLIER_WIDE_ADDER_FIELDS = ['molv', 'moq'];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Landed-cost adders/constraints that vary by supplier — independent of the cost access
 * sequence, which only picks WHICH cost candidate to use. A supplier is independent of
 * region (it manufactures in one country and ships to warehouses across regions), so
 * lookup is by supplier id alone. Resolved per line (an item's own `supplier`) and merged
 * over whatever API6 already put in facts.elements — a supplier-specific value wins where
 * set; anything it doesn't override keeps the API6/generic value.
 */
function applySupplierOverrides(facts, items, priceDate) {
  for (const item of items) {
    if (!item.supplier) continue;
    const supplierConfig = store.getEffectiveSupplierConfig(item.supplier, priceDate);
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
 * already arrives pre-resolved. A no-op for any region that hasn't declared a stockClassMap — stock
 * class isn't a concern there yet, so existing parts keep pricing exactly as before.
 *
 * Once a region does declare a map, every item must resolve to a mapped code or it comes
 * back MISSING(STOCK_CLASS_UNRESOLVED) from engine-core (via item.stockClassError) rather
 * than silently skipping stockClass-conditioned build-up elements — see kernel.js.
 */
function applyStockClassNormalization(facts, items, config) {
  if (!config.stockClassMap) return;
  for (const item of items) {
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
 * The Additional Cost flag (topic 10): a line-level selector the host UI exposes (e.g.
 * "0 - Nothing to add", "1 - Landed cost & Markup", "2 - Markup only", "3 - No Landed cost
 * and Pick", "4 - Landed cost & Markup, No tariff") that picks which build-up elements apply
 * for that one line — independent of stock class or region. Resolved through this region's
 * config.additionalCostMap into item.includeMarkup/includeLandedCost/includeTariff/
 * includePick, which buildUp `when` clauses read via `!== false`.
 *
 * Unlike stock class, an item that never sets additionalCost at all is NOT an error — the
 * flag is opt-in (most lines never touch it), and every include* flag stays unset, which
 * `!== false` treats as "not excluded" — i.e. every element still applies, exactly as before
 * this flag existed. Only an explicitly-set but unrecognized value is a typed MISSING.
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
 * Trelleborg's "price list" pricing technique (topic 7 of the reference-doc review): a
 * supplier COST that varies by quantity break (e.g. qty 10 -> 18.49, 25 -> 15.41, ...) — per
 * the owner, this is a supplier cost, not necessarily the final customer sell price, so it
 * still feeds into the normal landed-cost build-up (markup, freight, duty, pick) afterward,
 * exactly like any other resolved cost candidate.
 *
 * facts.qtyBreaks[partNumber] is that table (the shape a real API6 call would return). Two
 * ways a line ends up here:
 *  - Automatic (the normal case): any part carrying a qtyBreaks table gets its cost tier
 *    picked by the ACTUAL requested quantity — no special input needed, this is just how that
 *    part is priced.
 *  - The Americas MROQ standalone flow: a business user without host-system context can type
 *    a hypothetical Minimum Reorder Quantity (item.mroqOverride, only meaningful when
 *    item.ood === 'SMA' — see topic 2) and see the cost at THAT quantity break instead of the
 *    real order quantity. In the normal host-system-integrated flow, API6 already resolves
 *    which of Americas' cost tiers applies before facts reach us, so this only matters
 *    standalone.
 * Either way, the matching tier is added as one more cost candidate and explicitly selected
 * via item.selectedCostId — reusing engine-core's existing "an explicit user selection always
 * wins" precedence. An item that already carries its own selectedCostId (the caller
 * deliberately picked a specific candidate for some other reason) is left alone.
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

/**
 * Kit/BOM (topic 8): a kit header item (item.components: [{partNumber, quantity, ...}]) is
 * quoted as ONE line to the customer, priced as the sum of its components — each priced
 * through its own full, normal landed-cost build-up (a component can have its own supplier,
 * COO, stock class, exactly like an independent line), per the S4 Pricing sheet: "Users only
 * need to input the kit's main item... consolidation occurs at the header level." Lives here
 * in srv, as orchestration around engine-core's existing per-part price() — not a new kernel
 * concept — per the owner's explicit call.
 *
 * Every component across every kit in the request is flattened into ONE extra batch alongside
 * the regular (non-kit) items, so the existing per-item fact resolution (supplier overrides,
 * stock class, quantity-break cost) and a single price() call cover components exactly the
 * same way they cover any other line — no separate code path for "component pricing."
 */
function priceWithKits({ region, salesOrg, priceDate, facts, config, request }) {
  const items = request.items;
  const kitIndices = [];
  items.forEach((it, i) => {
    if (Array.isArray(it.components) && it.components.length > 0) kitIndices.push(i);
  });

  // With no kits in this batch, nonKitItems is every item and componentItems is empty — the
  // rest of this function degrades to exactly one price() call over the original items,
  // same as before kits existed. No separate no-kit code path needed.
  const nonKitItems = items.filter((_, i) => !kitIndices.includes(i));
  const componentItems = [];
  const componentOwner = []; // parallel array: which kit's request-array index each componentItems[i] belongs to
  for (const kitIndex of kitIndices) {
    for (const comp of items[kitIndex].components) {
      componentItems.push(comp);
      componentOwner.push(kitIndex);
    }
  }

  const flatItems = [...nonKitItems, ...componentItems];
  applySupplierOverrides(facts, flatItems, priceDate);
  applyStockClassNormalization(facts, flatItems, config);
  applyAdditionalCostFlags(flatItems, config);
  applyQuantityBreakCost(facts, flatItems);

  const flatResult = flatItems.length ? price({ request: { ...request, items: flatItems }, facts, config }) : { items: [] };
  const nonKitLines = flatResult.items.slice(0, nonKitItems.length);
  const componentLines = flatResult.items.slice(nonKitItems.length);

  const kitLines = kitIndices.map((kitIndex) => {
    const kitItem = items[kitIndex];
    if (!KIT_SUPPORTED_REGIONS.includes(region)) {
      return {
        partNumber: kitItem.partNumber,
        status: 'MISSING',
        missing: { reason: 'KIT_NOT_SUPPORTED_FOR_REGION', region, supportedRegions: KIT_SUPPORTED_REGIONS },
        trace: { kit: true, components: [] },
      };
    }

    const myComponentLines = componentLines.filter((_, i) => componentOwner[i] === kitIndex);
    const failed = myComponentLines.find((l) => l.status !== 'PRICED');
    if (failed) {
      return {
        partNumber: kitItem.partNumber,
        status: failed.status,
        missing: { reason: 'KIT_COMPONENT_UNRESOLVED', componentPartNumber: failed.partNumber, componentIssue: failed.missing },
        trace: { kit: true, components: myComponentLines },
      };
    }

    const currencies = [...new Set(myComponentLines.map((l) => l.result.currency))];
    if (currencies.length > 1) {
      return {
        partNumber: kitItem.partNumber,
        status: 'MISSING',
        missing: { reason: 'KIT_CURRENCY_MISMATCH', currencies },
        trace: { kit: true, components: myComponentLines },
      };
    }

    const total = myComponentLines.reduce(
      (sum, l) => sum.plus(new Decimal(l.result.unitPrice).times(l.result.quantity)),
      new Decimal(0),
    );
    return {
      partNumber: kitItem.partNumber,
      status: 'PRICED',
      result: { unitPrice: total.toString(), currency: currencies[0], quantity: kitItem.quantity },
      trace: { kit: true, components: myComponentLines },
    };
  });

  const merged = [];
  let nonKitCursor = 0;
  let kitCursor = 0;
  for (let i = 0; i < items.length; i++) {
    merged.push(kitIndices.includes(i) ? kitLines[kitCursor++] : nonKitLines[nonKitCursor++]);
  }
  return { items: merged };
}

/**
 * Real host systems (e.g. C4C) don't send our internal region code at all — they send a
 * customer's Origin of Data + salesOrg (see CLAUDE.md Decision Log, the C4C payload review),
 * and region-route config resolves that to a region. `payload.region` still wins whenever
 * the caller supplies it explicitly — same "explicit selection always wins" precedence used
 * everywhere else in this file (cost candidates, MROQ override) — so every existing caller
 * that already knows its region keeps working unchanged; this only fires when region is
 * omitted. Never a silent guess: an unresolvable (ood, salesOrg) is a typed 422, and a
 * resolved region always says how it got there (`region.derivedBy`), mirroring
 * `costCandidate.selectedBy`.
 */
function resolveRegion({ region, salesOrg, customerOod, priceDate }) {
  if (region) return { region, derivedBy: 'EXPLICIT' };
  if (!customerOod) return { region: null, derivedBy: null, reason: 'NO_REGION_OR_CUSTOMER_OOD' };
  const route = store.getEffectiveRegionRoute(customerOod, salesOrg, priceDate);
  if (!route) return { region: null, derivedBy: null, reason: 'NO_MATCHING_REGION_ROUTE' };
  return { region: route.region, derivedBy: `ROUTE:${customerOod}`, entityLabel: route.entityLabel };
}

module.exports = (srv) => {
  srv.on('price', async (req) => {
    const payload = req.data.payload || {};
    const { salesOrg = '*', purpose = 'INDICATIVE', items, instructions, hostSystem, hostObjectType, hostObjectId, customerId, customerOod } = payload;
    const priceDate = payload.priceDate || todayIso();

    if (!Array.isArray(items) || items.length === 0) return req.reject(400, 'payload.items must be a non-empty array.');

    // party-config is customerId's master data (territory/country/currency/ood); an explicit
    // payload.customerOod overrides its stored customerOod, same precedence pattern as every
    // other override in this file.
    const partyConfig = customerId ? store.getEffectivePartyConfig(customerId, priceDate) : null;
    const resolvedCustomerOod = customerOod || (partyConfig && partyConfig.customerOod) || null;

    const { region, derivedBy: regionDerivedBy, entityLabel, reason: regionUnresolvedReason } =
      resolveRegion({ region: payload.region, salesOrg, customerOod: resolvedCustomerOod, priceDate });
    if (!region) {
      return req.reject(400, `payload.region is required (or provide customerId/customerOod that resolves via region-route) — ${regionUnresolvedReason}.`);
    }

    const config = store.getEffectiveAsOf(region, salesOrg, priceDate);
    if (!config) {
      return req.reject(422, `No effective config for region "${region}" / salesOrg "${salesOrg}" as of ${priceDate}.`);
    }

    // Kit components need their own facts too (they're priced as full lines in their own
    // right), so fetch for every part number that will actually be priced, not just the
    // top-level request items.
    const allPartNumbers = items.flatMap((it) => (Array.isArray(it.components) ? it.components : [it]));
    const facts = await api6.getPricingFacts({ region, salesOrg, items: allPartNumbers });

    const request = {
      context: { hostSystem: hostSystem || 'API', hostObjectType: hostObjectType || 'QUOTE', hostObjectId, purpose },
      party: {
        customerId,
        salesOrg,
        ood: resolvedCustomerOod,
        territory: partyConfig ? partyConfig.territory : null,
        country: partyConfig ? partyConfig.customerCountry : null,
        currency: partyConfig ? partyConfig.customerCurrency : null,
      },
      items,
      priceDate,
      instructions,
    };

    const result = priceWithKits({ region, salesOrg, priceDate, facts, config, request });

    return {
      config: { region: config.region, salesOrg: config.salesOrg, version: config.version, status: config.status },
      region: { value: region, derivedBy: regionDerivedBy, entityLabel: entityLabel || null },
      priceDate,
      requestedBy: req.user.id,
      ...result,
    };
  });
};
