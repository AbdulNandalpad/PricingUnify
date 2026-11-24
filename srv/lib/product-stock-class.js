'use strict';

/**
 * Resolve a C4C product's stock class from its per-sales-org rows (ProductSales) to the
 * canonical MTS/NonMTS through the region's OWN stockClassMap. Pure — no I/O.
 * Never a guess: an unresolvable case returns a typed `note`, no `stockClass`.
 *   sales:      [{ salesOrg, stockClassRaw }]
 *   salesOrg:   the quote's sales org ('*' / empty = unknown -> consider every row)
 *   map:        region-config.stockClassMap or null
 */
function resolveProductStockClass(sales, { salesOrg, map }) {
  const rows = Array.isArray(sales) ? sales : [];
  const own = salesOrg && salesOrg !== '*' ? rows.filter((s) => s.salesOrg === salesOrg) : [];
  const pool = own.length ? own : rows;
  const raws = [...new Set(pool.map((s) => s.stockClassRaw).filter(Boolean))];
  if (raws.length === 0) return { note: 'NO_STOCK_CLASS_IN_C4C' };
  if (raws.length > 1) return { note: `AMBIGUOUS:${raws.join('/')}` };
  const raw = raws[0];
  if (!map) return { stockClassRaw: raw, note: 'NO_STOCK_CLASS_MAP_FOR_REGION' };
  if (Object.prototype.hasOwnProperty.call(map, raw)) return { stockClassRaw: raw, stockClass: map[raw] };
  return { stockClassRaw: raw, note: `UNMAPPED:${raw}` };
}

module.exports = { resolveProductStockClass };
