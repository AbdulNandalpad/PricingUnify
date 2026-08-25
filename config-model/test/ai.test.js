const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigStore } = require('../src/store');
const { ConfigValidationError } = require('../src/validate');
const { createFakeClient } = require('../src/ai/client');
const { suggestConfigChange } = require('../src/ai/suggest');
const { applySuggestion, rejectSuggestion } = require('../src/ai/apply');
const { europeConfig } = require('./fixtures');
const { price } = require('@tss-pricing/engine-core');

function tariffSurchargePatch() {
  return {
    patch: [
      {
        op: 'add',
        path: '/buildUp/-',
        value: {
          id: 'CHINA_TARIFF_SURCHARGE',
          type: 'FACTOR',
          basis: ['BASE_COST'],
          rate: 0.03,
          when: "item.coo === 'CN'",
          provenance: { source: 'AI_SUGGESTED', authoredAt: '2026-08-25T00:00:00Z' },
        },
      },
    ],
    rationale: 'Instruction asked for a 3% tariff surcharge on China-origin parts, applied on the base cost.',
    confidence: 0.86,
  };
}

test('suggestConfigChange records the instruction and proposal without touching the store', async () => {
  const store = new ConfigStore();
  const base = store.saveVersion(europeConfig());
  const aiClient = createFakeClient(tariffSurchargePatch());

  const suggestion = await suggestConfigChange({
    aiClient,
    region: 'EUROPE',
    salesOrg: '*',
    currentConfig: base,
    instruction: 'Add a 3% tariff surcharge for parts sourced from China, on top of base cost.',
    requestedBy: 'pricing-lead@tss.example',
  });

  assert.equal(suggestion.status, 'PENDING_REVIEW');
  assert.equal(suggestion.aiModel, 'fake-client');
  assert.equal(suggestion.baseVersion, '2026.08.0');
  assert.equal(store.listVersions('EUROPE', '*').length, 1, 'no new version until a human approves');
});

test('suggestConfigChange rejects a currentConfig for the wrong salesOrg', async () => {
  const base = europeConfig({ salesOrg: 'DE01' });
  await assert.rejects(
    () =>
      suggestConfigChange({
        aiClient: createFakeClient(tariffSurchargePatch()),
        region: 'EUROPE',
        salesOrg: '*',
        currentConfig: base,
        instruction: 'Add China tariff.',
      }),
    /salesOrg/,
  );
});

test('an approved suggestion becomes a new, valid, ACTIVE version that engine-core can price against', async () => {
  const store = new ConfigStore();
  const base = store.saveVersion(europeConfig());
  const aiClient = createFakeClient(tariffSurchargePatch());
  const suggestion = store.saveSuggestion(
    await suggestConfigChange({ aiClient, region: 'EUROPE', salesOrg: '*', currentConfig: base, instruction: 'Add China tariff.' }),
  );

  const applied = applySuggestion(suggestion, { store, approvedBy: 'head-of-pricing@tss.example', newVersion: '2026.08.1' });

  assert.equal(applied.status, 'ACTIVE');
  assert.equal(applied.provenance.source, 'AI_SUGGESTED');
  assert.equal(applied.provenance.approvedBy, 'head-of-pricing@tss.example');
  assert.equal(suggestion.status, 'APPLIED');
  assert.equal(store.getVersion('EUROPE', '*', '2026.08.0').status, 'SUPERSEDED');

  const facts = {
    costs: { 'P-1': { default: 'C', candidates: [{ value: '100.00', currency: 'EUR', confidence: 'EXACT', source: { key: 'C' } }] } },
    elements: { 'P-1': { freight: '5.00', duty: '2.00', pickCharge: '21.00', molv: '0' } },
  };
  const request = { context: { purpose: 'INDICATIVE' }, items: [{ partNumber: 'P-1', quantity: 10, coo: 'CN' }] };
  // engine-core's `when` scope is { item, facts } — mirror that so the CN condition evaluates true.
  const line = price({ request: { ...request, items: [{ ...request.items[0] }] }, facts, config: applied }).items[0];

  assert.equal(line.status, 'PRICED');
  // 100 (base) + 4.7 (SCM 4.7%) + 3.0 (new China tariff 3%) + 5 (freight) + 2 (duty) + 2.1 (pick/10) = 116.8
  assert.equal(line.result.unitPrice, '116.8');
  assert.ok(line.trace.steps.some((s) => s.id === 'CHINA_TARIFF_SURCHARGE'));
});

test('a rejected suggestion never reaches the store', async () => {
  const store = new ConfigStore();
  const base = store.saveVersion(europeConfig());
  const aiClient = createFakeClient(tariffSurchargePatch());
  const suggestion = store.saveSuggestion(
    await suggestConfigChange({ aiClient, region: 'EUROPE', salesOrg: '*', currentConfig: base, instruction: 'Add China tariff.' }),
  );

  rejectSuggestion(suggestion, { reviewedBy: 'head-of-pricing@tss.example', reviewNotes: 'Finance wants 2.5%, not 3%.' });

  assert.equal(suggestion.status, 'REJECTED');
  assert.equal(store.listVersions('EUROPE', '*').length, 1);
  assert.throws(() => applySuggestion(suggestion, { store, approvedBy: 'x', newVersion: '2026.08.1' }));
});

test('the AI cannot bypass the FACTOR-basis non-negotiable — an invalid patch is refused, not silently applied', async () => {
  const store = new ConfigStore();
  const base = store.saveVersion(europeConfig());
  const invalidPatch = {
    patch: [{ op: 'add', path: '/buildUp/-', value: { id: 'BAD_FACTOR', type: 'FACTOR', rate: 0.1, provenance: { source: 'AI_SUGGESTED', authoredAt: '2026-08-25T00:00:00Z' } } }],
    rationale: 'Missing basis on purpose, to prove validation catches it.',
    confidence: 0.4,
  };
  const suggestion = store.saveSuggestion(
    await suggestConfigChange({ aiClient: createFakeClient(invalidPatch), region: 'EUROPE', salesOrg: '*', currentConfig: base, instruction: 'Add a bad factor.' }),
  );

  assert.throws(
    () => applySuggestion(suggestion, { store, approvedBy: 'head-of-pricing@tss.example', newVersion: '2026.08.1' }),
    ConfigValidationError,
  );
  assert.equal(store.listVersions('EUROPE', '*').length, 1, 'store is untouched when the AI proposal is invalid');
  assert.equal(suggestion.status, 'PENDING_REVIEW', 'a failed apply leaves the suggestion for a human to see and retry');
});

test('an AI suggestion scoped to one sales org only patches that sales org\'s config, not the region default', async () => {
  const store = new ConfigStore();
  store.saveVersion(europeConfig()); // region-wide default
  const de01Base = store.saveVersion(europeConfig({ salesOrg: 'DE01', version: 'DE01-2026.08.0' }));

  const suggestion = store.saveSuggestion(
    await suggestConfigChange({
      aiClient: createFakeClient(tariffSurchargePatch()),
      region: 'EUROPE',
      salesOrg: 'DE01',
      currentConfig: de01Base,
      instruction: 'Add China tariff for DE01 only.',
    }),
  );
  applySuggestion(suggestion, { store, approvedBy: 'head-of-pricing@tss.example', newVersion: 'DE01-2026.08.1' });

  assert.equal(store.getEffectiveAsOf('EUROPE', 'DE01', '2026-08-15').version, 'DE01-2026.08.1');
  assert.equal(store.getEffectiveAsOf('EUROPE', '*', '2026-08-15').version, '2026.08.0', 'region default is untouched');
  assert.equal(store.getEffectiveAsOf('EUROPE', 'FR01', '2026-08-15').version, '2026.08.0', 'other sales orgs still get the region default');
});
