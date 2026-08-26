let counter = 0;
function nextId() {
  counter += 1;
  return `row-${counter}`;
}

export function newRow(overrides = {}) {
  return { id: nextId(), partNumber: '', quantity: 1, supplier: '', supplierCountry: '', ood: '', warehouse: '', mroqOverride: '', components: [], kitOpen: false, ...overrides };
}

/** One kit component line — a kit header's price is the sum of its components, each priced
 *  as a full line by the backend (Americas/China only; see srv's priceWithKits). */
export function newComponent(overrides = {}) {
  return { id: nextId(), partNumber: '', quantity: 1, ood: '', ...overrides };
}

export const DEFAULT_ROWS = [
  newRow({ partNumber: 'P-10023', quantity: 10 }),
  newRow({ partNumber: 'P-20045', quantity: 25 }),
  newRow({ partNumber: 'P-30078', quantity: 4 }),
];

/**
 * Bulk-add: one line per part, comma or tab separated:
 * partNumber, quantity[, supplier[, supplierCountry[, OOD[, warehouse[, mroqOverride]]]]].
 * Quantity defaults to 1 if omitted or not a number. Blank lines are skipped.
 */
export function parseBulkText(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [partNumber, quantity, supplier, supplierCountry, ood, warehouse, mroqOverride] = line.split(/[,\t]/).map((s) => (s ?? '').trim());
      const qty = Number(quantity);
      return newRow({
        partNumber,
        quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
        supplier: supplier || '',
        supplierCountry: supplierCountry || '',
        ood: ood || '',
        warehouse: warehouse || '',
        mroqOverride: mroqOverride || '',
      });
    })
    .filter((row) => row.partNumber);
}

/** items[] payload for the backend — strips UI-only fields (id, kitOpen), drops empty attributes. */
export function toPricingItems(rows) {
  return rows
    .filter((r) => r.partNumber.trim())
    .map((r) => {
      const item = { partNumber: r.partNumber.trim(), quantity: Number(r.quantity) || 1 };
      if (r.supplier?.trim()) item.supplier = r.supplier.trim();
      if (r.supplierCountry?.trim()) item.supplierCountry = r.supplierCountry.trim();
      if (r.ood?.trim()) item.ood = r.ood.trim();
      if (r.warehouse?.trim()) item.warehouse = r.warehouse.trim();
      if (r.mroqOverride?.trim()) item.mroqOverride = r.mroqOverride.trim();
      const components = (r.components || [])
        .filter((c) => c.partNumber.trim())
        .map((c) => {
          const comp = { partNumber: c.partNumber.trim(), quantity: Number(c.quantity) || 1 };
          if (c.ood?.trim()) comp.ood = c.ood.trim();
          return comp;
        });
      if (components.length > 0) item.components = components;
      return item;
    });
}
