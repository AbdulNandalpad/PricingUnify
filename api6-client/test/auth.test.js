const { test } = require('node:test');
const assert = require('node:assert/strict');
const { noAuth, apiKeyAuth, basicAuth, oauth2ClientCredentialsAuth, btpDestinationAuth } = require('../src/auth/strategies');

test('noAuth adds no headers', async () => {
  assert.deepEqual(await noAuth().getHeaders(), {});
});

test('apiKeyAuth puts the key on the configured header', async () => {
  const strategy = apiKeyAuth({ headerName: 'X-Api-Key', apiKey: 'secret123' });
  assert.equal(strategy.type, 'API_KEY');
  assert.deepEqual(await strategy.getHeaders(), { 'X-Api-Key': 'secret123' });
});

test('apiKeyAuth requires a key', () => {
  assert.throws(() => apiKeyAuth({}), /apiKey/);
});

test('basicAuth base64-encodes username:password', async () => {
  const strategy = basicAuth({ username: 'svc-pricing', password: 'hunter2' });
  const headers = await strategy.getHeaders();
  assert.equal(headers.Authorization, `Basic ${Buffer.from('svc-pricing:hunter2').toString('base64')}`);
});

test('oauth2ClientCredentialsAuth fetches and caches a bearer token', async () => {
  let tokenRequests = 0;
  const fetchImpl = async (url, init) => {
    tokenRequests += 1;
    assert.equal(url, 'https://auth.example/token');
    assert.match(init.body, /grant_type=client_credentials/);
    return { ok: true, json: async () => ({ access_token: `tok-${tokenRequests}`, expires_in: 3600 }) };
  };
  const strategy = oauth2ClientCredentialsAuth({
    tokenUrl: 'https://auth.example/token',
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl,
  });

  const first = await strategy.getHeaders();
  const second = await strategy.getHeaders();

  assert.equal(first.Authorization, 'Bearer tok-1');
  assert.equal(second.Authorization, 'Bearer tok-1', 'a valid cached token is reused, not re-fetched');
  assert.equal(tokenRequests, 1);
});

test('oauth2ClientCredentialsAuth refreshes an expired token', async () => {
  let tokenRequests = 0;
  const fetchImpl = async () => {
    tokenRequests += 1;
    return { ok: true, json: async () => ({ access_token: `tok-${tokenRequests}`, expires_in: 0 }) };
  };
  const strategy = oauth2ClientCredentialsAuth({ tokenUrl: 'https://auth.example/token', clientId: 'id', clientSecret: 'secret', fetchImpl });

  await strategy.getHeaders();
  const second = await strategy.getHeaders();

  assert.equal(second.Authorization, 'Bearer tok-2');
  assert.equal(tokenRequests, 2);
});

test('oauth2ClientCredentialsAuth surfaces a failed token request', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, statusText: 'Unauthorized' });
  const strategy = oauth2ClientCredentialsAuth({ tokenUrl: 'https://auth.example/token', clientId: 'id', clientSecret: 'bad', fetchImpl });
  await assert.rejects(() => strategy.getHeaders(), /401/);
});

test('btpDestinationAuth delegates to BasicAuthentication when the resolved destination says so', async () => {
  const resolveDestination = async (name) => {
    assert.equal(name, 'API6');
    return { Authentication: 'BasicAuthentication', User: 'svc', Password: 'pw' };
  };
  const strategy = btpDestinationAuth({ destinationName: 'API6', resolveDestination });

  assert.equal(strategy.type, 'BTP_DESTINATION');
  const headers = await strategy.getHeaders();
  assert.equal(headers.Authorization, `Basic ${Buffer.from('svc:pw').toString('base64')}`);
  assert.deepEqual(await strategy.describe(), { destinationName: 'API6', delegatesTo: 'BASIC' });
});

test('btpDestinationAuth delegates to NoAuthentication', async () => {
  const strategy = btpDestinationAuth({ destinationName: 'API6', resolveDestination: async () => ({ Authentication: 'NoAuthentication' }) });
  assert.deepEqual(await strategy.getHeaders(), {});
});

test('btpDestinationAuth rejects an unsupported destination Authentication type', async () => {
  const strategy = btpDestinationAuth({ destinationName: 'API6', resolveDestination: async () => ({ Authentication: 'PrincipalPropagation' }) });
  await assert.rejects(() => strategy.getHeaders(), /Unsupported destination Authentication type/);
});
