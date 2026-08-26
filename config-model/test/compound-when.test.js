const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRegionConfig } = require('../src/validate');
const { europeConfig, HUMAN_PROVENANCE } = require('./fixtures');
const { price } = require('@tss-pricing/engine-core');

test('an array `when` (AND-ed conditions) validates on a build-up element', () => {
  const config = europeConfig({
    buildUp: [
      { id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE },
      { id: 'CONDITIONED', type: 'ADDER', amount: 5, when: ["item.ood !== 'CN'", "item.coo === 'US'"], provenance: HUMAN_PROVENANCE },
    ],
    constraints: [],
  });
  assert.equal(validateRegionConfig(config), true);
});

test('a config-model-authored China-shaped compound `when` build-up prices each real branch correctly through engine-core', () => {
  const config = europeConfig({
    region: 'CHINA',
    buildUp: [
      { id: 'BASE_COST', type: 'BASE', provenance: HUMAN_PROVENANCE },
      { id: 'ROUTE_JDE_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.032, when: "item.ood === 'CN'", provenance: HUMAN_PROVENANCE },
      { id: 'FREIGHT_DUTY_US', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.32, composite: true, allocatable: false, when: ["item.ood !== 'CN'", "item.supplierCountry === 'US'"], provenance: HUMAN_PROVENANCE },
      { id: 'FREIGHT_DUTY_NONUS', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.21, composite: true, allocatable: false, when: ["item.ood !== 'CN'", "item.supplierCountry !== 'US'"], provenance: HUMAN_PROVENANCE },
      { id: 'DIRECT_MARKUP', type: 'FACTOR', basis: ['BASE_COST', 'FREIGHT_DUTY_US', 'FREIGHT_DUTY_NONUS'], rate: 0.032, when: ["item.ood !== 'CN'", "item.supplier !== '88058'"], provenance: HUMAN_PROVENANCE },
      { id: 'LCE_MARKUP_BASE', type: 'FACTOR', basis: ['BASE_COST', 'FREIGHT_DUTY_US', 'FREIGHT_DUTY_NONUS'], rate: 0.032, when: ["item.ood !== 'CN'", "item.supplier === '88058'"], provenance: HUMAN_PROVENANCE },
      { id: 'LCE_MARKUP', type: 'FACTOR', basis: ['BASE_COST', 'FREIGHT_DUTY_US', 'FREIGHT_DUTY_NONUS', 'LCE_MARKUP_BASE'], rate: 0.06, when: ["item.ood !== 'CN'", "item.supplier === '88058'"], provenance: HUMAN_PROVENANCE },
    ],
    constraints: [],
    rounding: { mode: 'HALF_UP', decimalPlaces: 8 },
  });
  assert.equal(validateRegionConfig(config), true);

  const facts = { costs: { 'P-1': { default: 'C', candidates: [{ value: '100.00', currency: 'CNY', confidence: 'EXACT', source: { key: 'C' } }] } }, elements: {} };
  const priceFor = (itemOverrides) => {
    const request = { context: { purpose: 'INDICATIVE' }, items: [{ partNumber: 'P-1', quantity: 1, ...itemOverrides }] };
    return price({ request, facts, config }).items[0];
  };

  // Branch 1: OOD is JDE China -- already landed, just the 3.2% LCS markup.
  assert.equal(priceFor({ ood: 'CN' }).result.unitPrice, '103.2');
  // Branch 2: direct from a non-LCE supplier -- freight&duty by supplier country, then 3.2% markup.
  assert.equal(priceFor({ ood: 'SAP', supplier: 'ACME', supplierCountry: 'US' }).result.unitPrice, '136.224');
  assert.equal(priceFor({ ood: 'SAP', supplier: 'ACME', supplierCountry: 'IT' }).result.unitPrice, '124.872');
  // Branch 3: via LCE/SAP Europe (supplier 88058) -- freight&duty, 3.2% markup, then 6% LCE markup on top.
  assert.equal(priceFor({ ood: 'SAP', supplier: '88058', supplierCountry: 'US' }).result.unitPrice, '144.39744');
  assert.equal(priceFor({ ood: 'SAP', supplier: '88058', supplierCountry: 'IT' }).result.unitPrice, '132.36432');
});
