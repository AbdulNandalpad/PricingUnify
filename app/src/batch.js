/** Line-grid row model and the mapping to the neutral pricing request's `items[]`. */
let counter = 0;
function nextId() {
  counter += 1;
  return `row-${counter}`;
}

export function newRow(overrides = {}) {
  return {
    id: nextId(),
    partNumber: '',
    quantity: 1,
    pricingType: '', // '' = let the routing rules decide; a value is a per-line override
    supplier: '',
    warehouse: '',
    stockClass: '', // '' = auto from the part's ERP code via the region's stock class map
    additionalCost: '',
    ood: '',
    mroqOverride: '',
    marginOverride: undefined, // cost plus only — set from the why? drawer slider
    components: [],
    kitOpen: false,
    description: '', // from fetchItemAttributes (product master), never typed
    ...overrides,
  };
}

/** One kit component — a kit header's price is the sum of its components, each priced as
 *  a full line by the backend (Americas / China). */
export function newComponent(overrides = {}) {
  return { id: nextId(), partNumber: '', quantity: 1, ood: '', ...overrides };
}

/** The prototype's opening quote — real seeded parts, one per technique. */
export const DEFAULT_ROWS = [
  newRow({ partNumber: 'EU-T100', quantity: 10, supplier: 'ACME', warehouse: 'EU01' }),
  newRow({ partNumber: 'P-10023', quantity: 50 }),
  newRow({ partNumber: 'P-70200', quantity: 10, supplier: 'INITECH', warehouse: 'EU01' }),
  newRow({ partNumber: 'P-40012', quantity: 20 }),
  newRow({ partNumber: 'OR-25X3-NBR', quantity: 500 }),
  newRow({ partNumber: 'PTFE-BRG-120', quantity: 4 }),
  newRow({ partNumber: 'PTFE-BRG-137', quantity: 2 }),
];

export const BULK_COLUMNS = 'part, qty, supplier, warehouse, stock class, data origin, qty override';

/** Bulk add — one line per part, comma / tab / semicolon separated, columns as
 *  BULK_COLUMNS; everything after the part is optional. A header row is skipped. */
export function parseBulkText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l, i) => !(i === 0 && /^part/i.test(l)))
    .map((l) => {
      const [partNumber, quantity, supplier, warehouse, stockClass, ood, mroqOverride] = l.split(/[,\t;]/).map((s) => (s ?? '').trim());
      const qty = Number(quantity);
      return newRow({
        partNumber,
        quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
        supplier: supplier || '',
        warehouse: warehouse || '',
        stockClass: stockClass === 'MTS' || stockClass === 'NonMTS' ? stockClass : '',
        ood: ood || '',
        mroqOverride: mroqOverride || '',
      });
    })
    .filter((r) => r.partNumber);
}

export function rowToItem(r) {
  const item = { partNumber: r.partNumber.trim(), quantity: Number(r.quantity) || 1 };
  if (r.pricingType) item.pricingType = r.pricingType;
  if (r.book) item.book = r.book;
  if (r.supplier?.trim()) item.supplier = r.supplier.trim();
  if (r.warehouse?.trim()) item.warehouse = r.warehouse.trim();
  if (r.stockClass?.trim()) item.stockClass = r.stockClass.trim();
  if (r.additionalCost !== '' && r.additionalCost !== undefined && r.additionalCost !== null) item.additionalCost = String(r.additionalCost);
  if (r.ood?.trim()) item.ood = r.ood.trim();
  if (String(r.mroqOverride ?? '').trim()) item.mroqOverride = String(r.mroqOverride).trim();
  if (r.marginOverride !== undefined && r.marginOverride !== null && r.marginOverride !== '') item.marginOverride = String(r.marginOverride);
  const components = (r.components || [])
    .filter((c) => c.partNumber.trim())
    .map((c) => {
      const comp = { partNumber: c.partNumber.trim(), quantity: Number(c.quantity) || 1 };
      if (c.ood?.trim()) comp.ood = c.ood.trim();
      return comp;
    });
  if (components.length > 0) item.components = components;
  return item;
}

/** items[] for the backend — blank rows dropped; UI-only fields (id, kitOpen, description) stripped. */
export function toPricingItems(rows) {
  return rows.filter((r) => r.partNumber.trim()).map(rowToItem);
}
