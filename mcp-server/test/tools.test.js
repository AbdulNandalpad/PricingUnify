'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient, ApiError } = require('../src/client');
const { createTools } = require('../src/tools');

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.user-token';
const BEARER = `Bearer ${TOKEN}`;

function fakeFetch(responder = () => ({ ok: true })) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: new URL(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = responder(call);
    const status = r.status ?? 200;
    const text = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { fetch, calls };
}

function harness(responder, env = { PRICING_USER_TOKEN: TOKEN }) {
  const { fetch, calls } = fakeFetch(responder);
  const client = createClient({ env, fetch });
  const tools = Object.fromEntries(createTools(client).map((t) => [t.name, t]));
  return { client, tools, calls };
}

function parsed(result) {
  return JSON.parse(result.content[1].text);
}

test('createClient refuses to start without a user credential', () => {
  assert.throws(() => createClient({ env: {}, fetch: async () => {} }), (err) => {
    assert.equal(err.code, 'NO_CREDENTIAL');
    assert.match(err.message, /no identity of its own/);
    assert.match(err.message, /PRICING_USER_TOKEN/);
    return true;
  });
  assert.throws(() => createClient({ env: { PRICING_USER: 'bob' }, fetch: async () => {} }), /PRICING_PASSWORD/);
});

test('a user token becomes a Bearer header; user + password becomes Basic', () => {
  const bearer = createClient({ env: { PRICING_USER_TOKEN: TOKEN }, fetch: async () => {} });
  assert.equal(bearer.authorization, BEARER);
  const basic = createClient({ env: { PRICING_USER: 'bob', PRICING_PASSWORD: 'x' }, fetch: async () => {} });
  assert.equal(basic.authorization, `Basic ${Buffer.from('bob:x').toString('base64')}`);
});

test('base URL comes from PRICING_API_BASE and defaults to localhost:4004', async () => {
  const a = createClient({ env: { PRICING_USER_TOKEN: TOKEN }, fetch: async () => {} });
  assert.equal(a.baseUrl, 'http://localhost:4004');
  const { fetch, calls } = fakeFetch(() => ({ body: { id: 'bob' } }));
  const b = createClient({ env: { PRICING_USER_TOKEN: TOKEN, PRICING_API_BASE: 'https://pricing.example.com/' }, fetch });
  await b.get('/rest/pricing/whoami');
  assert.equal(calls[0].url.href, 'https://pricing.example.com/rest/pricing/whoami');
});

test('every tool forwards the Authorization header verbatim', async () => {
  const { tools, calls } = harness(() => ({ body: { items: [] } }));
  await tools.whoami.handler({});
  await tools.price_items.handler({ items: [{ partNumber: 'EU-T100', quantity: 10 }], purpose: 'INDICATIVE' });
  await tools.explain_price.handler({ documentId: 'd1' });
  await tools.fetch_item_attributes.handler({ items: [{ partNumber: 'EU-T100' }] });
  await tools.get_pricing_rules.handler({ kind: 'routing-rules' });
  await tools.list_books.handler({ kind: 'price-list' });
  await tools.simulate_change.handler({ draft: { kind: 'price-list', key: 'EU-LIST', version: 'v2' }, documentIds: ['d1'] });
  await tools.propose_rule_change.handler({ kind: 'region-config', key: 'EUROPE', instruction: 'raise margin to 28%' });
  await tools.list_pending_suggestions.handler({ status: 'PENDING_REVIEW' });
  assert.equal(calls.length, 9);
  for (const call of calls) assert.equal(call.headers.Authorization, BEARER);
});

test('whoami: GET /rest/pricing/whoami', async () => {
  const { tools, calls } = harness(() => ({ body: { id: 'bob', roles: ['PricingAdmin', 'PricingViewer'] } }));
  const res = await tools.whoami.handler({});
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.pathname, '/rest/pricing/whoami');
  assert.equal(res.content[0].text, 'Acting on behalf of bob · roles: PricingAdmin, PricingViewer');
  assert.deepEqual(parsed(res), { id: 'bob', roles: ['PricingAdmin', 'PricingViewer'] });
});

test('price_items: POST /rest/pricing/price with { payload } in the neutral request shape', async () => {
  const body = {
    documentId: 'doc-1',
    items: [
      { partNumber: 'EU-T100', status: 'PRICED', flags: [] },
      { partNumber: 'EU-T200', status: 'PRICED', flags: [{ level: 'crit', code: 'MARGIN_FLOOR' }] },
      { partNumber: 'EU-T300', status: 'MISSING', flags: [] },
    ],
  };
  const { tools, calls } = harness(() => ({ body }));
  const res = await tools.price_items.handler({
    items: [{ partNumber: 'EU-T100', quantity: 10, marginOverride: 0.3 }],
    region: 'EUROPE', salesOrg: 'DE01', customerId: 'CUST-DE-001', priceDate: '2026-09-10',
    purpose: 'BINDING', hostObjectType: 'QUOTE', hostObjectId: 'Q-77',
  });
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url.pathname, '/rest/pricing/price');
  assert.equal(call.url.search, '');
  assert.deepEqual(call.body.payload.items, [{ partNumber: 'EU-T100', quantity: 10, marginOverride: 0.3 }]);
  assert.deepEqual(call.body.payload.context, { hostSystem: 'MCP', hostObjectType: 'QUOTE', hostObjectId: 'Q-77', purpose: 'BINDING' });
  assert.deepEqual(call.body.payload.party, { customerId: 'CUST-DE-001', salesOrg: 'DE01' });
  assert.equal(call.body.payload.region, 'EUROPE');
  assert.equal(call.body.payload.priceDate, '2026-09-10');
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text, '2 of 3 lines priced · 2 need attention · document doc-1');
  assert.deepEqual(parsed(res), body);
});

test('explain_price: GET /rest/pricing/getPricingDocument?id=', async () => {
  const doc = { ID: 'doc-1', region: 'EUROPE', priceDate: '2026-09-10', requestedBy: 'bob', result: { items: [{}, {}] } };
  const { tools, calls } = harness(() => ({ body: doc }));
  const res = await tools.explain_price.handler({ documentId: 'doc-1' });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.pathname, '/rest/pricing/getPricingDocument');
  assert.equal(calls[0].url.searchParams.get('id'), 'doc-1');
  assert.equal(calls[0].body, undefined);
  assert.equal(res.content[0].text, 'Pricing document doc-1 · 2 lines · region EUROPE · priced as of 2026-09-10 · requested by bob');
});

test('fetch_item_attributes: POST /rest/pricing/fetchItemAttributes', async () => {
  const { tools, calls } = harness(() => ({ body: { items: [{ partNumber: 'EU-T100', supplier: 'ACME' }] } }));
  const res = await tools.fetch_item_attributes.handler({ items: [{ partNumber: 'EU-T100' }], region: 'EUROPE' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url.pathname, '/rest/pricing/fetchItemAttributes');
  assert.deepEqual(calls[0].body, { payload: { region: 'EUROPE', items: [{ partNumber: 'EU-T100' }] } }, 'unset optionals are not serialised');
  assert.equal(res.content[0].text, 'Attributes resolved for 1 item');
});

test('get_pricing_rules: GET /rest/config/getEffective?kind=&key=&asOf= for each kind', async () => {
  const { tools, calls } = harness(() => ({ body: { version: '2026-09-10-r1', status: 'ACTIVE', validFrom: '2026-09-01' } }));
  const res = await tools.get_pricing_rules.handler({ kind: 'price-list', key: 'EU-ORINGS', asOf: '2026-10-01' });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.pathname, '/rest/config/getEffective');
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { kind: 'price-list', key: 'EU-ORINGS', asOf: '2026-10-01' });
  assert.equal(res.content[0].text, 'Effective price-list "EU-ORINGS" · version 2026-09-10-r1 · ACTIVE · valid from 2026-09-01');

  await tools.get_pricing_rules.handler({ kind: 'region-config', key: 'EUROPE' });
  assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), { kind: 'region-config', key: 'EUROPE' }, 'asOf omitted when not given');

  await tools.get_pricing_rules.handler({ kind: 'routing-rules' });
  assert.deepEqual(Object.fromEntries(calls[2].url.searchParams), { kind: 'routing-rules', key: '*' }, 'routing-rules defaults key to *');

  const missing = await tools.get_pricing_rules.handler({ kind: 'catalog-book' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /key is required/);
  assert.equal(calls.length, 3, 'no request is made without a key');
});

test('list_books: GET /rest/config/listBooks?kind=', async () => {
  const { tools, calls } = harness(() => ({ body: [{ id: 'PTFE-CAT' }, { id: 'PTFE-CAT-2' }] }));
  const res = await tools.list_books.handler({ kind: 'catalog-book' });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.pathname, '/rest/config/listBooks');
  assert.equal(calls[0].url.searchParams.get('kind'), 'catalog-book');
  assert.equal(res.content[0].text, '2 catalog books');
});

test('simulate_change: POST /rest/pricing/simulate with draft + items/documentIds', async () => {
  const body = { items: [{ delta: '0' }, { delta: '-1.20' }, { delta: '3.00' }], floorCrossings: [{}], deadRows: [] };
  const { tools, calls } = harness(() => ({ body }));
  const draft = { kind: 'catalog-book', key: 'PTFE-CAT', version: '2026-09-10-r3' };
  const res = await tools.simulate_change.handler({ draft, items: [{ partNumber: 'PTFE-BRG-120', quantity: 5 }], documentIds: ['doc-1'] });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url.pathname, '/rest/pricing/simulate');
  assert.deepEqual(calls[0].body.payload.draft, draft);
  assert.deepEqual(calls[0].body.payload.items, [{ partNumber: 'PTFE-BRG-120', quantity: 5 }]);
  assert.deepEqual(calls[0].body.payload.documentIds, ['doc-1']);
  assert.equal(res.content[0].text, 'Simulated catalog-book "PTFE-CAT" v2026-09-10-r3 · 3 lines compared · 2 would change · 1 floor crossing');

  const empty = await tools.simulate_change.handler({ draft });
  assert.equal(empty.isError, true);
  assert.equal(calls.length, 1, 'nothing is sent without items or documentIds');
});

test('propose_rule_change: POST /rest/config/suggestChange targeting a document kind + key', async () => {
  const { tools, calls } = harness(() => ({ body: { id: 'sug-9', status: 'PENDING_REVIEW' } }));
  const res = await tools.propose_rule_change.handler({ kind: 'region-config', key: 'EUROPE', instruction: 'raise default margin to 28% from 1 Oct', version: '2026.01.0' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url.pathname, '/rest/config/suggestChange');
  assert.deepEqual(calls[0].body, { payload: { targetKind: 'region-config', targetKey: 'EUROPE', version: '2026.01.0', instruction: 'raise default margin to 28% from 1 Oct' } });
  assert.match(res.content[0].text, /^Suggestion sug-9 recorded as PENDING_REVIEW/);
  assert.match(res.content[0].text, /still has to publish/);
});

test('propose_rule_change: AI_NOT_CONFIGURED is reported plainly, not as a success', async () => {
  const { tools } = harness(() => ({ body: { status: 'AI_NOT_CONFIGURED' } }));
  const res = await tools.propose_rule_change.handler({ kind: 'price-list', key: 'EU-ORINGS', instruction: 'add a 5% tier at 500' });
  assert.match(res.content[0].text, /AI_NOT_CONFIGURED/);
  assert.match(res.content[0].text, /no suggestion was created/);
});

test('list_pending_suggestions: GET /rest/config/listSuggestions?status=PENDING_REVIEW', async () => {
  const { tools, calls } = harness(() => ({ body: [{ id: 'sug-9' }] }));
  const res = await tools.list_pending_suggestions.handler({ status: 'PENDING_REVIEW' });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.pathname, '/rest/config/listSuggestions');
  assert.equal(calls[0].url.searchParams.get('status'), 'PENDING_REVIEW');
  assert.equal(res.content[0].text, '1 suggestion with status PENDING_REVIEW');
});

test('a 403 NO_USER_PRINCIPAL is mapped into a readable on-behalf-of error', async () => {
  const { tools } = harness(() => ({ status: 403, body: { error: { code: 'NO_USER_PRINCIPAL', message: 'NO_USER_PRINCIPAL' } } }));
  const res = await tools.price_items.handler({ items: [{ partNumber: 'EU-T100', quantity: 1 }], purpose: 'INDICATIVE' });
  assert.equal(res.isError, true);
  assert.equal(res.content.length, 1);
  assert.match(res.content[0].text, /no user principal/);
  assert.match(res.content[0].text, /never a client-credentials token/);
});

test('a 403 whose message (not code) carries NO_USER_PRINCIPAL is mapped the same way', async () => {
  const { client } = harness(() => ({ status: 403, body: { error: { code: '403', message: 'NO_USER_PRINCIPAL: no user in token' } } }));
  await assert.rejects(client.get('/rest/pricing/whoami'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 403);
    assert.match(err.message, /no user principal/);
    return true;
  });
});

test('other server errors surface the server message and status', async () => {
  const { tools } = harness(() => ({ status: 422, body: { error: { code: '422', message: 'No effective config for region "MARS" / salesOrg "*".' } } }));
  const res = await tools.get_pricing_rules.handler({ kind: 'region-config', key: 'MARS' });
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, '422: No effective config for region "MARS" / salesOrg "*".');

  const { tools: t401 } = harness(() => ({ status: 401, text: 'Unauthorized' }));
  const res401 = await t401.whoami.handler({});
  assert.equal(res401.isError, true);
  assert.match(res401.content[0].text, /Not authenticated \(401\)/);
});

test('an unreachable server is reported without a stack trace', async () => {
  const client = createClient({ env: { PRICING_USER_TOKEN: TOKEN }, fetch: async () => { throw new Error('ECONNREFUSED'); } });
  const [tool] = createTools(client);
  const res = await tool.handler({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Could not reach the pricing API at http:\/\/localhost:4004 \(ECONNREFUSED\)/);
});

test('successful results are a summary line followed by the pretty-printed JSON', async () => {
  const { tools } = harness(() => ({ body: { id: 'alice', roles: ['PricingViewer'] } }));
  const res = await tools.whoami.handler({});
  assert.equal(res.content.length, 2);
  assert.equal(res.content[0].type, 'text');
  assert.equal(res.content[1].type, 'text');
  assert.equal(res.content[1].text, JSON.stringify({ id: 'alice', roles: ['PricingViewer'] }, null, 2));
});

test('the tool set matches ARCHITECTURE_V2 §5 and every tool has a zod input schema', () => {
  const client = createClient({ env: { PRICING_USER_TOKEN: TOKEN }, fetch: async () => {} });
  const names = createTools(client).map((t) => t.name);
  assert.deepEqual(names, [
    'whoami', 'price_items', 'explain_price', 'fetch_item_attributes', 'get_pricing_rules',
    'list_books', 'simulate_change', 'propose_rule_change', 'list_pending_suggestions',
  ]);
  for (const tool of createTools(client)) {
    assert.equal(typeof tool.inputSchema, 'object');
    assert.ok(tool.description.length > 40, `${tool.name} needs a description an agent can act on`);
    assert.equal(typeof tool.handler, 'function');
  }
});
