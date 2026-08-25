let counter = 0;
function nextId() {
  counter += 1;
  return `row-${counter}`;
}

export function newRow(overrides = {}) {
  return { id: nextId(), partNumber: '', quantity: 1, coo: '', ...overrides };
}

export const DEFAULT_ROWS = [
  newRow({ partNumber: 'P-10023', quantity: 10 }),
  newRow({ partNumber: 'P-20045', quantity: 25 }),
  newRow({ partNumber: 'P-30078', quantity: 4 }),
];

/**
 * Bulk-add: one line per part, comma or tab separated: partNumber, quantity[, COO].
 * Quantity defaults to 1 if omitted or not a number. Blank lines are skipped.
 */
export function parseBulkText(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [partNumber, quantity, coo] = line.split(/[,\t]/).map((s) => (s ?? '').trim());
      const qty = Number(quantity);
      return newRow({ partNumber, quantity: Number.isFinite(qty) && qty > 0 ? qty : 1, coo: coo || '' });
    })
    .filter((row) => row.partNumber);
}

/** items[] payload for the backend — strips UI-only fields (id), drops empty attributes. */
export function toPricingItems(rows) {
  return rows
    .filter((r) => r.partNumber.trim())
    .map((r) => {
      const item = { partNumber: r.partNumber.trim(), quantity: Number(r.quantity) || 1 };
      if (r.coo?.trim()) item.coo = r.coo.trim();
      return item;
    });
}
