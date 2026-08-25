const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRegionConfig } = require('../src/validate');
const { europeConfig, HUMAN_PROVENANCE } = require('./fixtures');
const { price } = require('@tss-pricing/engine-core');

test('costAccessSequence is a valid optional field on region-config', () => {
  const config = europeConfig({ costAccessSequence: ['C4C', 'ERP', 'CCD', 'CCP'] });
  assert.equal(validateRegionConfig(config), true);
});

test('a config-model-authored costAccessSequence actually drives cost resolution through engine-core', () => {
  const config = europeConfig({ costAccessSequence: ['C4C', 'ERP', 'CCD', 'CCP'], provenance: HUMAN_PROVENANCE });

  const facts = {
    costs: {
      'P-1': {
        default: 'ERP_1',
        candidates: [
          { value: '100.00', currency: 'EUR', basis: 'MOVING_AVG', confidence: 'EXACT', source: { system: 'ERP', key: 'ERP_1' } },
          { value: '92.00', currency: 'EUR', basis: 'MANUAL', confidence: 'EXACT', source: { system: 'C4C', key: 'C4C_1' } },
        ],
      },
    },
    elements: { 'P-1': { freight: '0', duty: '0', pickCharge: '0', molv: '0' } },
  };
  const request = { context: { purpose: 'INDICATIVE' }, items: [{ partNumber: 'P-1', quantity: 1 }] };

  const line = price({ request, facts, config }).items[0];

  // C4C precedes ERP in the access sequence, so the manual C4C cost (92) wins over the
  // ERP default (100) even though `default` in facts points at ERP.
  assert.equal(line.status, 'PRICED');
  assert.equal(line.trace.costCandidate.source.system, 'C4C');
  assert.equal(line.trace.costCandidate.selectedBy, 'ACCESS_SEQUENCE:C4C');
});
