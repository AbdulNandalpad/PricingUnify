const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { hermeticEnv } = require('./hermetic-env');

const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'api', 'openapi.json'), 'utf8'));
const cds = fs.readFileSync(path.join(__dirname, '..', 'pricing-service.cds'), 'utf8');

const PORT = 4997;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
const auth = (u) => `Basic ${Buffer.from(`${u}:x`).toString('base64')}`;

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: hermeticEnv({ PORT: String(PORT), PRICING_MAX_ITEMS: '5', TSS_VIEWER_FOR_ALL: 'false' }), stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('srv did not start');
});
after(() => child.kill('SIGKILL'));

test('every path in the OpenAPI contract is a real action/function of PricingService (spec cannot drift)', () => {
  for (const [p, ops] of Object.entries(spec.paths)) {
    const name = p.replace(/^\//, '');
    const method = Object.keys(ops)[0];
    const decl = method === 'post' ? `action ${name}(` : `function ${name}(`;
    assert.ok(cds.includes(decl), `${method.toUpperCase()} ${p} has no "${decl}" in pricing-service.cds`);
    assert.equal(ops[method].operationId, name);
  }
});

test('the spec is served unauthenticated at /api/openapi.json', async () => {
  const res = await fetch(`${BASE}/api/openapi.json`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).info.title, 'TSS Pricing Engine API');
});

test('the contract\'s documented status codes are what the API answers', async () => {
  const post = (user, payload) => fetch(`${BASE}/rest/pricing/price`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: auth(user) } : {}) }, body: JSON.stringify({ payload }) });
  const items = (n) => Array.from({ length: n }, () => ({ partNumber: 'EU-T100', quantity: 1 }));
  assert.equal((await post(null, { region: 'EUROPE', items: items(1) })).status, 401);
  assert.equal((await post('carol', { region: 'EUROPE', items: items(1) })).status, 403);
  assert.equal((await post('alice', { region: 'EUROPE', items: [] })).status, 400);
  assert.equal((await post('alice', { region: 'EUROPE', items: items(5) })).status, 200);
  const big = await post('alice', { region: 'EUROPE', items: items(6) });
  assert.equal(big.status, 413);
  assert.match((await big.json()).error.message, /maximum per request is 5/);
  assert.equal((await post('alice', { region: 'EUROPE', salesOrg: 'NOPE', priceDate: '1999-01-01', items: items(1) })).status, 422);
});

test('kit components count toward the line cap', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth('alice') },
    body: JSON.stringify({ payload: { region: 'CHINA', items: [{ partNumber: 'K', quantity: 1, components: Array.from({ length: 5 }, (_, i) => ({ partNumber: `C${i}`, quantity: 1 })) }] } }) });
  assert.equal(res.status, 413);
});
