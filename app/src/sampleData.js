import { CONFIDENCE, PURPOSE } from '@tss-pricing/engine-core';

/**
 * Synthetic Europe-shaped region config — NOT real TSS rates. Only the fallback for when the
 * backend isn't running; normally the Demo fetches the selected region's real effective
 * config and derives its input fields from it.
 */
export const DEMO_CONFIG = {
  region: 'EUROPE',
  version: '2026.08.0-demo',
  buildUp: [
    { id: 'BASE_COST', type: 'BASE' },
    { id: 'SCM_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.047 },
    { id: 'FREIGHT', type: 'ADDER', amountRef: 'freight' },
    { id: 'DUTY', type: 'ADDER', amountRef: 'duty' },
    { id: 'PICK_CHARGE', type: 'PER_LINE', amountRef: 'pickCharge' },
  ],
  constraints: [{ id: 'MOLV', type: 'CONSTRAINT', kind: 'FLOOR', minRef: 'molv' }],
  rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
};

export const DEFAULT_FORM = {
  partNumber: 'P-10023',
  quantity: 10,
  purpose: PURPOSE.INDICATIVE,
  baseCostValue: '100.00',
  currency: 'EUR',
  confidence: CONFIDENCE.EXACT,
  overrideStaleCost: false,
  simulateMissingCost: false,
  stockClass: '',
  ood: '',
  supplier: '',
  supplierCountry: '',
};

/** Sensible starting values for the fact fields a region's config references — anything the
 *  config asks for that isn't listed here starts at 0. */
export const DEFAULT_FACT_VALUES = {
  freight: '5.00',
  duty: '2.00',
  tariff: '0',
  pickCharge: '21.00',
  molv: '50.00',
  moq: '1',
};

/** Which per-part fact fields a config actually reads (amountRef/rateRef on build-up steps,
 *  minRef/stepRef on order rules) — the Demo renders exactly these as inputs, nothing more.
 *  A region whose config references no freight has no freight field: the attributes come
 *  from the config, not from a hardcoded form. Returns [{ ref, usedBy: [stepIds] }]. */
export function factRefsOf(config) {
  const refs = new Map();
  const add = (ref, id) => {
    if (!ref) return;
    if (!refs.has(ref)) refs.set(ref, []);
    refs.get(ref).push(id);
  };
  for (const el of config.buildUp || []) {
    add(el.amountRef, el.id);
    add(el.rateRef, el.id);
  }
  for (const c of config.constraints || []) {
    add(c.minRef, c.id);
    add(c.stepRef, c.id);
  }
  return [...refs.entries()].map(([ref, usedBy]) => ({ ref, usedBy }));
}

/** Which item-level fields the config's `when` conditions branch on (stock class, data
 *  origin, …) — the Demo only offers the fields this region's rules actually look at.
 *  The include* flags are excluded: they come from the Additional Cost flag resolution in
 *  srv, not from direct user input. */
export function itemFieldsOf(config) {
  const fields = new Set();
  const scan = (when) => {
    for (const expr of Array.isArray(when) ? when : when ? [when] : []) {
      for (const m of String(expr).match(/item\.([A-Za-z0-9_]+)/g) || []) {
        fields.add(m.replace('item.', ''));
      }
    }
  };
  (config.buildUp || []).forEach((el) => scan(el.when));
  (config.constraints || []).forEach((c) => scan(c.when));
  for (const internal of ['includeMarkup', 'includeLandedCost', 'includeTariff', 'includePick']) {
    fields.delete(internal);
  }
  return fields;
}

/** Builds the { request, facts, config } shape engine-core's price() expects. `factValues`
 *  holds exactly the fields `factRefsOf(config)` derived — the demo's per-part facts. */
export function buildPricingInput(form, config = DEMO_CONFIG, factValues = DEFAULT_FACT_VALUES) {
  const item = {
    partNumber: form.partNumber,
    quantity: Number(form.quantity),
    overrideStaleCost: form.overrideStaleCost,
  };
  if (form.stockClass) item.stockClass = form.stockClass;
  if (form.ood?.trim()) item.ood = form.ood.trim();
  if (form.supplier?.trim()) item.supplier = form.supplier.trim();
  if (form.supplierCountry?.trim()) item.supplierCountry = form.supplierCountry.trim();

  const request = {
    context: { hostSystem: 'DEV_CONSOLE', hostObjectType: 'QUOTE', purpose: form.purpose },
    items: [item],
  };

  const facts = {
    // Omitting the entry entirely simulates API6 having no cost record for this part yet —
    // the real-world MISSING case (§5.2), distinct from a candidate that resolved but is STALE/FALLBACK.
    costs: form.simulateMissingCost
      ? {}
      : {
          [form.partNumber]: {
            default: 'DEMO_CANDIDATE',
            candidates: [
              {
                value: form.baseCostValue,
                currency: form.currency,
                basis: 'MOVING_AVG',
                source: { system: 'S4', table: 'MBEW', field: 'VERPR', key: 'DEMO_CANDIDATE' },
                validFrom: '2026-08-01',
                retrievedAt: '2026-08-20T00:00:00Z',
                confidence: form.confidence,
              },
            ],
          },
        },
    elements: {
      [form.partNumber]: { ...factValues },
    },
  };

  return { request, facts, config };
}
