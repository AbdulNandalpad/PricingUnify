const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApi6Client, apiKeyAuth } = require('../src/index');

test('defaults to recorded mode with no auth required', async () => {
  const client = createApi6Client();
  assert.equal(client.mode, 'recorded');
  assert.equal(client.authType, 'NONE');
});

test('getPricingFacts replays the region-shaped recorded fixture', async () => {
  const client = createApi6Client();
  const facts = await client.getPricingFacts({ region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-10023', quantity: 10 }] });

  assert.ok(facts.costs['P-10023']);
  assert.equal(facts.costs['P-10023'].candidates[0].value, '100.00');
  assert.equal(facts.elements['P-10023'].freight, '0.05'); // freight is a RATE (5%), not an amount -- owner correction 2026-08-26
});

test('live mode is configurable with a real auth strategy without needing a network call to construct it', () => {
  const client = createApi6Client({ mode: 'live', baseUrl: 'https://api6.example', auth: apiKeyAuth({ apiKey: 'k' }) });
  assert.equal(client.mode, 'live');
  assert.equal(client.authType, 'API_KEY');
});
