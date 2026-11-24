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
  if (!wh) {
    out.warehouseNote = rows.length === 0 ? 'NO_WAREHOUSE_IN_C4C' : 'NO_USABLE_STOCK_CLASS';
  } else {
    out.stockClassWarehouse = wh.warehouseId;
    if (wh.stockClassRaw) out.stockClassRaw = wh.stockClassRaw;
    if (wh.leadTime) out.leadTime = wh.leadTime;
    if (wh.country) out.country = wh.country;
  }
  return out;
}

module.exports = { pickOriginOfData };
