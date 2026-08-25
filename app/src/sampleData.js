import { CONFIDENCE, PURPOSE } from '@tss-pricing/engine-core';

/**
 * Synthetic Europe-shaped region config — NOT real TSS rates. Mirrors the concept deck's
 * build-up (moving-avg BASE, SCM 4.7% FACTOR, freight/duty ADDERs, pick-charge PER_LINE,
 * MOLV floor CONSTRAINT) so the kernel has something real to run in this standalone demo.
 * Real, finance-verified region configs land via config-model + tests/golden in Phase 1/2.
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
  freight: '5.00',
  duty: '2.00',
  pickCharge: '21.00',
  molv: '50.00',
};

/** Builds the { request, facts, config } shape engine-core's price() expects, straight from the form. */
export function buildPricingInput(form) {
  const request = {
    context: { hostSystem: 'DEV_CONSOLE', hostObjectType: 'QUOTE', purpose: form.purpose },
    items: [
      {
        partNumber: form.partNumber,
        quantity: Number(form.quantity),
        overrideStaleCost: form.overrideStaleCost,
      },
    ],
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
      [form.partNumber]: {
        freight: form.freight,
        duty: form.duty,
        pickCharge: form.pickCharge,
        molv: form.molv,
      },
    },
  };

  return { request, facts, config: DEMO_CONFIG };
}
