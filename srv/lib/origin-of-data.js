'use strict';

const stripZeros = (v) => String(v === undefined || v === null ? '' : v).trim().replace(/^0+(?=.)/, '');

/**
 * Pick the supplier and warehouse record that apply to ONE quote line from the neutral rows of
 * the custom OriginOfData BO. Pure — no I/O. Mirrors C4C's own getSupplierInformation lookup
 * (material -> the node of the line's Origin of Data, leading zeros stripped -> Supplier node
 * whose own Origin of Data equals it) and never guesses: ambiguity comes back as a typed note.
 *   suppliers:  [{partNumber, ood, parentOod, supplierId, externalId, name, isDefault}]
 *   warehouses: [{partNumber, ood, warehouseId, stockClassRaw, leadTime, country, preferred}]
 *   line:       { partNumber, ood }   (the line's warehouse plays no part in stock class)
 *   knownStockClasses: optional Set of raw classes the region's stockClassMap knows
 */
function pickOriginOfData({ suppliers, warehouses }, line, { knownStockClasses } = {}) {
  const part = String(line.partNumber || '').trim();
  const ood = stripZeros(line.ood);
  const out = {};
  if (!part || !ood) { out.note = 'NO_ORIGIN_OF_DATA_ON_LINE'; return out; }

  // ---- supplier ----
  const candidates = (suppliers || []).filter((s) =>
    s.partNumber === part && stripZeros(s.parentOod) === ood && stripZeros(s.ood) === ood && (s.supplierId || s.externalId));
  if (candidates.length === 0) {
    out.supplierNote = 'NO_SUPPLIER_IN_C4C';
  } else {
    let chosen = null;
    if (candidates.length === 1) chosen = candidates[0];
    else {
      const defaults = candidates.filter((s) => s.isDefault);
      if (defaults.length === 1) chosen = defaults[0];
      else out.supplierNote = `AMBIGUOUS_SUPPLIER:${candidates.map((s) => s.supplierId || s.externalId).join('/')}`;
    }
    if (chosen) out.supplier = { id: chosen.supplierId, externalId: chosen.externalId, name: chosen.name };
  }

  // ---- stock class (and lead time / country) from the node's warehouse ----
  // Exactly as C4C's retrivePriceBI does: the PREFERRED warehouse of the Origin-of-Data node,
  // else the first warehouse carrying a usable stock class. The LINE's own warehouse is NOT
  // used for this (the script ignores it; it only defaults that field by country). "Usable" =
  // a raw class the region's stockClassMap knows (config), so no class codes live in code.
  const rows = (warehouses || []).filter((w) => w.partNumber === part && stripZeros(w.ood) === ood);
  const preferred = rows.find((w) => w.preferred);
  const wh = preferred || rows.find((w) => w.stockClassRaw && (!knownStockClasses || knownStockClasses.has(w.stockClassRaw))) || null;
  const prefRow = rows.find((w) => w.preferred);
  if (prefRow) out.preferredWarehouse = prefRow.warehouseId;
  if (!wh) {
    out.warehouseNote = rows.length === 0 ? 'NO_WAREHOUSE_IN_C4C' : 'NO_USABLE_STOCK_CLASS';
  } else {
    out.stockClassWarehouse = wh.warehouseId;
    if (wh.stockClassRaw) out.stockClassRaw = wh.stockClassRaw;
    if (wh.strategyCode) { out.strategyGroupCode = wh.strategyCode; out.strategyGroupDesc = wh.strategyDesc || ''; }
    if (wh.leadTime) out.leadTime = wh.leadTime;
    if (wh.country) out.country = wh.country;
  }
  return out;
}

/**
 * Canonical stock class for a picked record — or a typed reason why not. Pure.
 *   1. Region `stockClassRules` (owner's golden rule): a rule set COVERS an Origin of Data when
 *      some rule names it (Europe's names SAP). For a covered origin the first rule matching
 *      the line's Origin of Data AND the part's strategy group wins, else the set's default
 *      (SAP + Z4 = MTS, SAP + anything else = NonMTS). Origins no rule names are NOT touched by
 *      it — other origins buy from SAP, not the other way round. Applied only when a warehouse
 *      record was found (nothing to classify otherwise — never the default by accident).
 *   2. Otherwise: a strategy group still blocks the plain StockClass (typed
 *      STRATEGY_GROUP_RULE_PENDING — the warehouse StockClass column alone is not what C4C
 *      sends); without a strategy group the raw StockClass goes through the region's stockClassMap.
 */
function stockClassFromPicked(picked, map, { rules, ood } = {}) {
  const covered = rules && (rules.rules || []).some((r) => stripZeros(r.ood) === stripZeros(ood));
  if (covered) {
    if (!picked.stockClassWarehouse) return {};
    const code = picked.strategyGroupCode || '';
    const hit = (rules.rules || []).find((r) => stripZeros(r.ood) === stripZeros(ood) && r.strategyCode === code);
    return { stockClass: hit ? hit.stockClass : rules.default, stockClassBy: hit ? `RULE:${hit.ood}/${hit.strategyCode}` : 'RULE:DEFAULT' };
  }
  if (picked.strategyGroupCode) {
    return { note: `STRATEGY_GROUP_RULE_PENDING:${picked.strategyGroupCode}${picked.strategyGroupDesc ? ` (${picked.strategyGroupDesc})` : ''}` };
  }
  if (!picked.stockClassRaw) return {};
  if (!map) return { note: 'NO_STOCK_CLASS_MAP_FOR_REGION' };
  if (Object.prototype.hasOwnProperty.call(map, picked.stockClassRaw)) return { stockClass: map[picked.stockClassRaw] };
  return { note: `UNMAPPED:${picked.stockClassRaw}` };
}

/**
 * The warehouse a line gets (owner rule): the part's PREFERRED warehouse from its Origin-of-Data
 * record, otherwise the region's configured default (Europe: 1020). Pure. No preferred warehouse
 * and no default = nothing (never invented).
 */
function warehouseFromPicked(picked, defaultWarehouse) {
  if (picked && picked.preferredWarehouse) return { warehouse: picked.preferredWarehouse, warehouseBy: 'PREFERRED' };
  if (defaultWarehouse) return { warehouse: String(defaultWarehouse), warehouseBy: 'DEFAULT' };
  return {};
}

/** The default warehouse of the region that OWNS the line's Origin of Data (SAP -> EUROPE),
 *  falling back to the pricing region's own — same lookup as the stock-class rules. */
function defaultWarehouseForOod({ store, ood, pricingDefault, date }) {
  try {
    const key = stripZeros(ood);
    const route = key ? store.getEffectiveRegionRoute(key, '*', date) : null;
    const owner = route ? store.getEffectiveAsOf(route.region, '*', date) : null;
    return (owner && owner.defaultWarehouse) || pricingDefault || null;
  } catch (e) {
    return pricingDefault || null;
  }
}

/**
 * The stock-class rules that apply to a line: those of the region that OWNS the line's Origin
 * of Data (via region-route, e.g. SAP -> EUROPE), so a China / Americas / India quote buying a
 * SAP-sourced part gets the Europe answer; falling back to the pricing region's own rules.
 */
function stockClassRulesForOod({ store, ood, pricingRules, date }) {
  try {
    const key = stripZeros(ood);
    const route = key ? store.getEffectiveRegionRoute(key, '*', date) : null;
    const owner = route ? store.getEffectiveAsOf(route.region, '*', date) : null;
    return (owner && owner.stockClassRules) || pricingRules || null;
  } catch (e) {
    return pricingRules || null;
  }
}

module.exports = { pickOriginOfData, stockClassFromPicked, stockClassRulesForOod, warehouseFromPicked, defaultWarehouseForOod };
