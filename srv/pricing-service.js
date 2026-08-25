const { price } = require('@tss-pricing/engine-core');
const { store } = require('./lib/store');
const { api6 } = require('./lib/api6');

const SUPPLIER_ADDER_FIELDS = ['freight', 'duty', 'tariff', 'molv', 'moq'];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Landed-cost adders/constraints that vary by supplier (freight, duty, tariff, MOLV, MOQ) —
 * independent of the cost access sequence, which only picks WHICH cost candidate to use.
 * Resolved per line (an item's own `supplier`, falling back to config-model's "*" region-wide
 * default) and merged over whatever API6 already put in facts.elements — a supplier-specific
 * value wins where set; anything it doesn't override keeps the API6/generic value.
 */
function applySupplierOverrides(facts, items, region, salesOrg, priceDate) {
  for (const item of items) {
    if (!item.supplier) continue;
    const supplierConfig = store.getEffectiveSupplierConfig(region, salesOrg, item.supplier, priceDate);
    if (!supplierConfig) continue;

    const overrides = {};
    for (const field of SUPPLIER_ADDER_FIELDS) {
      if (supplierConfig[field] !== undefined && supplierConfig[field] !== null) overrides[field] = supplierConfig[field];
    }
    if (Object.keys(overrides).length === 0) continue;

    facts.elements[item.partNumber] = { ...(facts.elements[item.partNumber] || {}), ...overrides };
  }
}

/**
 * Normalizes each item's raw ERP stock-class code (facts.classification[partNumber]
 * .stockClassRaw — e.g. China's OMT/SMT/CMT, Americas' MTS-Z/MTS-2C) into the canonical
 * item.stockClass ('MTS'|'NonMTS') engine-core's `when` conditions branch on, using this
 * region's config.stockClassMap. Mutates items in place, mirroring how item.coo already
 * arrives pre-resolved. A no-op for any region that hasn't declared a stockClassMap — stock
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

module.exports = (srv) => {
  srv.on('price', async (req) => {
    const payload = req.data.payload || {};
    const { region, salesOrg = '*', purpose = 'INDICATIVE', items, instructions, hostSystem, hostObjectType, hostObjectId, customerId } = payload;
    const priceDate = payload.priceDate || todayIso();

    if (!region) return req.reject(400, 'payload.region is required.');
    if (!Array.isArray(items) || items.length === 0) return req.reject(400, 'payload.items must be a non-empty array.');

    const config = store.getEffectiveAsOf(region, salesOrg, priceDate);
    if (!config) {
      return req.reject(422, `No effective config for region "${region}" / salesOrg "${salesOrg}" as of ${priceDate}.`);
    }

    const facts = await api6.getPricingFacts({ region, salesOrg, items });
    applySupplierOverrides(facts, items, region, salesOrg, priceDate);
    applyStockClassNormalization(facts, items, config);
    applyQuantityBreakCost(facts, items);

    const request = {
      context: { hostSystem: hostSystem || 'API', hostObjectType: hostObjectType || 'QUOTE', hostObjectId, purpose },
      party: { customerId, salesOrg },
      items,
      priceDate,
      instructions,
    };

    const result = price({ request, facts, config });

    return {
      config: { region: config.region, salesOrg: config.salesOrg, version: config.version, status: config.status },
      priceDate,
      requestedBy: req.user.id,
      ...result,
    };
  });
};
