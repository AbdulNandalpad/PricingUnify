/**
 * TEMPORARY cost source (owner decision 2026-11-24): the API6 BI price endpoint currently does
 * the whole calculation; until API6 exposes cost-only endpoints we ask it for the cost ALONE
 * (api6.fetchBiCosts forces Additional Cost "0" and zero picks, so it hands the cost back 1:1)
 * and run OUR build-up on top. Pure helpers: no I/O here, so they are unit-testable.
 */

const str = (v) => (v === undefined || v === null ? '' : String(v));

/** Our canonical stock class -> the raw group code the BI contract speaks (MTS/MTO). */
function biStockClass(stockClass) {
  if (stockClass === 'MTS') return 'MTS';
  if (stockClass === 'NonMTS') return 'MTO';
  return '';
}

/**
 * Builds the C4C-shaped BI request body for a batch of (flat) pricing items. lineId is the
 * 1-based position in `items`, which is how answers are mapped back to lines.
 */
function buildBiBody({ items, customerId, customerOod, customer, hostObjectId, userId }) {
  const c = customer || {};
  return {
    customer: {
      customerId: str(customerId),
      salesTerritory: str(c.salesTerritory),
      originOfData: str(customerOod),
      countryCode: str(c.countryCode),
      custcurrency: str(c.currency),
      priceGroup: str(c.priceGroup),
      classCode: str(c.classCode),
      quoteId: str(hostObjectId),
      userIdentifier: str(userId),
      userName: str(userId),
    },
    item: items.map((it, i) => ({
      lineId: String(i + 1),
      warehouseCode: str(it.warehouse),
      itemLongNumber: str(it.partNumber),
      salesQuantity: Number(it.quantity) || 1,
      unitCode: str(it.uom),
      uom: str(it.uom),
      itemCategoryCode: str(it.productCategory),
      c4cUnitCostAmt: 0,
      c4cPickCount: 0,
      useCostPlusFlag: '0',
      stockClassGroupCode: biStockClass(it.stockClass),
      supplierMainGroupCode: str(it.supplier),
      supplierExternalID: str(it.supplierExternalId),
      supplierCountryCode: str(it.supplierCountry),
    })),
  };
}

/**
 * Turns the BI answer into one explicitly selected cost candidate per line (same mechanism as
 * a host-provided cost: selectedCostId = "explicit selection wins"). Returns the per-line
 * routing notes the trace shows, so a failed or empty answer is visible, never silent.
 */
function applyBiCandidates(facts, items, bi) {
  const routingByItem = new Map();
  items.forEach((item, i) => {
    const lineId = String(i + 1);
    const note = { system: 'BI_PRICE_LIST', endpoint: bi.endpoint || null, found: false };
    routingByItem.set(item, [{ sequence: ['BI_PRICE_LIST'], calls: [note] }]);
    if (bi.status !== 'OK') { note.note = `${bi.status}${bi.message ? `: ${bi.message}` : ''}`; return; }
    const cand = bi.candidates && bi.candidates[lineId];
    if (!cand || !cand.found) { note.note = (cand && cand.note) || 'no cost returned'; return; }
    const key = `BI_${item.partNumber}_${lineId}`;
    const existing = facts.costs[item.partNumber] || { default: null, candidates: [] };
    facts.costs[item.partNumber] = {
      ...existing,
      candidates: [...existing.candidates, {
        value: String(cand.value), currency: cand.currency, basis: cand.basis,
        source: { ...cand.source, key }, confidence: cand.confidence,
      }],
    };
    item.selectedCostId = key;
    note.found = true;
  });
  return routingByItem;
}

module.exports = { buildBiBody, applyBiCandidates, biStockClass };
