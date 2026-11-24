'use strict';

const stripZeros = (v) => String(v === undefined || v === null ? '' : v).trim().replace(/^0+(?=.)/, '');

/**
 * Pick the supplier and warehouse record that apply to ONE quote line from the neutral rows of
 * the custom OriginOfData BO. Pure — no I/O. Mirrors C4C's own getSupplierInformation lookup
 * (material -> the node of the line's Origin of Data, leading zeros stripped -> Supplier node
 * whose own Origin of Data equals it) and never guesses: ambiguity comes back as a typed note.
 *   suppliers:  [{partNumber, ood, parentOod, supplierId, externalId, name, isDefault}]
 *   warehouses: [{partNumber, ood, warehouseId, stockClassRaw, leadTime, country, preferred}]
 *   line:       { partNumber, ood, warehouse }
 */
function pickOriginOfData({ suppliers, warehouses }, line) {
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

  // ---- warehouse (stock class, lead time, country) ----
  const rows = (warehouses || []).filter((w) => w.partNumber === part && stripZeros(w.ood) === ood);
  const wanted = stripZeros(line.warehouse);
  let wh = null;
  if (wanted) {
    wh = rows.find((w) => stripZeros(w.warehouseId) === wanted) || null;
    if (!wh) out.warehouseNote = `WAREHOUSE_NOT_FOUND:${wanted}`;
  } else {
    const preferred = rows.filter((w) => w.preferred);
    if (preferred.length === 1) wh = preferred[0];
    else if (rows.length === 1) wh = rows[0];
    else out.warehouseNote = rows.length === 0 ? 'NO_WAREHOUSE_IN_C4C' : 'WAREHOUSE_NOT_ON_LINE';
  }
  if (wh) {
    out.warehouseId = wh.warehouseId;
    if (wh.stockClassRaw) out.stockClassRaw = wh.stockClassRaw;
    if (wh.leadTime) out.leadTime = wh.leadTime;
    if (wh.country) out.country = wh.country;
  }
  return out;
}

module.exports = { pickOriginOfData };
