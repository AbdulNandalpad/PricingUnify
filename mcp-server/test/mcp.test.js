const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createMcpServer, createPricingClient, createHttpServer, toApiItem } = require('../src');

const SRV_PORT = 4998;
const SRV = `http://127.0.0.1:${SRV_PORT}`;
let srv;

const basic = (u) => `Basic ${Buffer.from(`${u}:x`).toString('base64')}`;

async function waitForHealth() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${SRV}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('srv did not start');
}

before(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', '..', 'srv', 'server.js')], { env: { ...process.env, PORT: String(SRV_PORT) }, stdio: 'ignore' });
  await waitForHealth();
});
after(() => srv.kill('SIGKILL'));

/** An MCP client wired in-memory to a server whose pricing client authenticates as `user`. */
async function connect(user, opts = {}) {
  const client = createPricingClient({ baseUrl: SRV, authorization: user ? basic(user) : undefined });
  const server = createMcpServer({ getClient: () => client }, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(a);
  return mcp;
}

test('toApiItem maps marginPct/manualPrice into the API shape and drops unknown fields', () => {
  const it = toApiItem({ partNumber: 'A', quantity: 2, marginPct: 20, manualPrice: 5, evil: 'x', supplier: '' });
  assert.deepEqual(it, { partNumber: 'A', quantity: 2, margin: { marginPct: '20' }, manualPrice: '5' });
});

test('lists the five agent tools, admin tools only when enabled; no write tools ever', async () => {
  const names = async (opts) => (await (await connect('alice', opts)).listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(await names(), ['explain_price', 'get_item_attributes', 'price_items', 'search_products', 'whoami']);
  const admin = await names({ enableAdmin: true });
  assert.ok(admin.includes('get_region_config') && admin.includes('list_suppliers'));
  assert.ok(!admin.some((n) => /save|approve|write|suggest/.test(n)));
});

test('every tool is annotated read-only', async () => {
  const { tools } = await (await connect('bob', { enableAdmin: true })).listTools();
  for (const t of tools) assert.equal(t.annotations.readOnlyHint, true, t.name);
});

test('price_items prices EU-T100 through the real API with the pinned value and flags demo data', async () => {
  const mcp = await connect('alice');
  const r = await mcp.callTool({ name: 'price_items', arguments: { region: 'EUROPE', items: [{ partNumber: 'EU-T100', quantity: 10 }] } });
  assert.ok(!r.isError);
  const s = r.structuredContent;
  assert.equal(s.priced, 1);
  assert.equal(s.dataSource, 'DEMO_DATA');
  assert.equal(s.lines[0].landedCost, '138.74'); // same value pinned in srv/test/api.test.js
  assert.equal(s.lines[0].stockClass, 'NonMTS');
  assert.equal(s.lines[0].costSource.system, 'CCD');
});

test('price_items with marginPct returns a selling price; supplier+warehouse terms apply', async () => {
  const mcp = await connect('alice');
  const r = await mcp.callTool({ name: 'price_items', arguments: { region: 'EUROPE', items: [{ partNumber: 'EU-T100', quantity: 10, supplier: 'ACME', warehouse: 'EU01', marginPct: 20 }] } });
  const l = r.structuredContent.lines[0];
  assert.equal(l.landedCost, '157.07');
  assert.equal(l.sellingPrice, '196.34');
  assert.equal(l.priceBy, 'MARGIN');
});

test('an unknown part is a MISSING line with a reason and hint, not a tool error', async () => {
  const mcp = await connect('alice');
  const r = await mcp.callTool({ name: 'price_items', arguments: { region: 'EUROPE', items: [{ partNumber: 'NOPE-1', quantity: 1 }] } });
  assert.ok(!r.isError);
  const l = r.structuredContent.lines[0];
  assert.equal(l.status, 'MISSING');
  assert.ok(l.reason);
});

test('OPPORTUNITY is cost-only through MCP too: no sellingPrice even when a margin is passed', async () => {
  const mcp = await connect('alice');
  const r = await mcp.callTool({ name: 'price_items', arguments: { region: 'EUROPE', hostObjectType: 'OPPORTUNITY', items: [{ partNumber: 'EU-T100', quantity: 10, marginPct: 30 }] } });
  const l = r.structuredContent.lines[0];
  assert.equal(r.structuredContent.costOnly, true);
  assert.equal(l.landedCost, '138.74');
  assert.equal(l.sellingPrice, undefined);
});

test('explain_price returns a readable calculation naming the cost source and steps', async () => {
  const mcp = await connect('alice');
  const r = await mcp.callTool({ name: 'explain_price', arguments: { region: 'EUROPE', item: { partNumber: 'EU-T100', quantity: 10 } } });
  const text = r.content[0].text;
  assert.match(text, /Cost used: 100/);
  assert.match(text, /SCM_MARKUP/);
  assert.match(text, /PICK_CHARGE/);
  assert.match(text, /landed cost 138.74 EUR/);
});

test('input validation happens before the API is called (negative quantity, unknown field, bad region)', async () => {
  const mcp = await connect('alice');
  for (const args of [
    { region: 'EUROPE', items: [{ partNumber: 'A', quantity: -1 }] },
    { region: 'EUROPE', items: [{ partNumber: 'A', quantity: 1, bogus: 1 }] },
    { region: 'MARS', items: [{ partNumber: 'A', quantity: 1 }] },
  ]) {
    const r = await mcp.callTool({ name: 'price_items', arguments: args }).catch((e) => ({ isError: true, thrown: e }));
    assert.ok(r.isError || r.thrown, JSON.stringify(args));
  }
});

test('a caller without a role gets a clear 403 message as a tool error; whoami still works', async () => {
  const mcp = await connect('carol');
  const r = await mcp.callTool({ name: 'price_items', arguments: { region: 'EUROPE', items: [{ partNumber: 'EU-T100', quantity: 1 }] } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /lack the required role/);
  const me = await mcp.callTool({ name: 'whoami', arguments: {} });
  assert.deepEqual(me.structuredContent.roles, { PricingViewer: false, PricingAdmin: false });
});

test('missing credentials surface as a 401 tool error', async () => {
  const mcp = await connect(undefined);
  const r = await mcp.callTool({ name: 'whoami', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /rejected the credentials/);
});

test('admin read tools: PricingAdmin can read config; a viewer is refused by the backend', async () => {
  const bob = await connect('bob', { enableAdmin: true });
  const cfg = await bob.callTool({ name: 'get_region_config', arguments: { region: 'EUROPE' } });
  assert.equal(cfg.structuredContent.region, 'EUROPE');
  const sup = await bob.callTool({ name: 'list_suppliers', arguments: {} });
  assert.ok(sup.structuredContent.suppliers.length > 0);
  const alice = await connect('alice', { enableAdmin: true });
  const denied = await alice.callTool({ name: 'list_suppliers', arguments: {} });
  assert.equal(denied.isError, true);
});

test('the guide resource is served', async () => {
  const mcp = await connect('alice');
  const res = await mcp.readResource({ uri: 'pricing://guide' });
  assert.match(res.contents[0].text, /Stock class/);
});

test('an unreachable API is a clear tool error, not a crash', async () => {
  const client = createPricingClient({ baseUrl: 'http://127.0.0.1:1', authorization: basic('alice'), timeoutMs: 2000 });
  const server = createMcpServer({ getClient: () => client });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const mcp = new Client({ name: 't', version: '0' }); await mcp.connect(a);
  const r = await mcp.callTool({ name: 'whoami', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not reachable/);
});

test('client-credentials tokens are fetched once and cached', async () => {
  let tokenCalls = 0; const seen = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/oauth/token')) { tokenCalls++; return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }); }
    seen.push(init.headers.Authorization);
    return new Response('{"ok":true}', { status: 200 });
  };
  const c = createPricingClient({ baseUrl: 'http://x', tokenUrl: 'http://auth/oauth/token', clientId: 'id', clientSecret: 's', fetchImpl });
  await c.get('/a'); await c.get('/b');
  assert.equal(tokenCalls, 1);
  assert.deepEqual(seen, ['Bearer tok', 'Bearer tok']);
});

test('HTTP transport: forwards the caller\'s own Authorization; refuses callers with none; blocks browser origins', async () => {
  const http = createHttpServer({ env: { TSS_PRICING_BASE_URL: SRV } });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${http.address().port}`;
  try {
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { Origin: 'https://evil.example', Authorization: basic('alice'), 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${url}/mcp`)).status, 405);

    const asUser = async (u) => {
      const t = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: basic(u) } } });
      const mcp = new Client({ name: 'h', version: '0' }); await mcp.connect(t);
      return mcp;
    };
    const alice = await asUser('alice');
    assert.equal((await alice.callTool({ name: 'whoami', arguments: {} })).structuredContent.id, 'alice');
    const bob = await asUser('bob');
    assert.equal((await bob.callTool({ name: 'whoami', arguments: {} })).structuredContent.roles.PricingAdmin, true);
    const priced = await alice.callTool({ name: 'price_items', arguments: { region: 'EUROPE', items: [{ partNumber: 'EU-T100', quantity: 10 }] } });
    assert.equal(priced.structuredContent.lines[0].landedCost, '138.74');
  } finally { http.close(); }
});
