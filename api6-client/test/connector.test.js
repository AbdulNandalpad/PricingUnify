const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createConnector } = require('../src/connector');
const { apiKeyAuth, noAuth } = require('../src/auth/strategies');

const RECORDED_DIR = path.join(__dirname, '../recorded');

test('recorded mode replays a JSON fixture by scenario name', async () => {
  const connector = createConnector({ mode: 'recorded', recordedDir: RECORDED_DIR });
  const payload = await connector.call('europe-default');
  assert.ok(payload.costs['P-10023']);
});

test('recorded mode fails clearly when the scenario has no fixture', async () => {
  const connector = createConnector({ mode: 'recorded', recordedDir: RECORDED_DIR });
  await assert.rejects(() => connector.call('nonexistent-scenario'), /No recorded payload/);
});

test('live mode sends the auth strategy\'s headers and the request body', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const connector = createConnector({
    mode: 'live',
    baseUrl: 'https://api6.example',
    authStrategy: apiKeyAuth({ headerName: 'apikey', apiKey: 'k123' }),
    fetchImpl,
  });

  const result = await connector.call(null, { method: 'POST', path: '/pricing-facts', body: { region: 'EUROPE' } });

  assert.deepEqual(result, { ok: true });
  assert.equal(captured.url, 'https://api6.example/pricing-facts');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.apikey, 'k123');
  assert.equal(JSON.parse(captured.init.body).region, 'EUROPE');
});

test('live mode surfaces a non-ok response as an error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' });
  const connector = createConnector({ mode: 'live', baseUrl: 'https://api6.example', authStrategy: noAuth(), fetchImpl });
  await assert.rejects(() => connector.call(null, { path: '/pricing-facts' }), /500/);
});

test('live mode requires a baseUrl', () => {
  assert.throws(() => createConnector({ mode: 'live' }), /baseUrl/);
});
