const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 4999;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

function basicAuthHeader(user) {
  return `Basic ${Buffer.from(`${user}:x`).toString('base64')}`;
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('srv did not become healthy in time');
}

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitForHealth();
});

after(() => {
  child.kill('SIGKILL');
});

test('an unauthenticated pricing request is rejected', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: { region: 'EUROPE', items: [{ partNumber: 'P-10023', quantity: 1 }] } }),
  });
  assert.equal(res.status, 401);
});

test('an authenticated pricing request prices against the seeded EUROPE config', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-10023', quantity: 10 }] } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const [line] = body.items;
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '113.8'); // same synthetic build-up as engine-core/config-model tests
  assert.equal(body.config.version, '2026.08.0');
  assert.equal(body.requestedBy, 'alice');
});

test('a supplier override changes freight/duty/tariff/MOLV/MOQ, applied over the generic API6 elements', async () => {
  const withoutSupplier = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-70200', quantity: 10 }] } }),
  }).then((r) => r.json());
  assert.equal(withoutSupplier.items[0].status, 'PRICED');
  assert.equal(withoutSupplier.items[0].result.unitPrice, '167.35'); // generic freight/duty/tariff=0

  const withAcme = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-70200', quantity: 30, supplier: 'ACME' }] } }),
  }).then((r) => r.json());
  assert.equal(withAcme.items[0].status, 'PRICED');
  assert.equal(withAcme.items[0].result.unitPrice, '197.25'); // ACME's higher freight/duty/tariff, quantity above ACME's MOQ so no constraint fires
  assert.equal(withAcme.items[0].trace.constraintPasses.length, 0);
});

test('a below-MOQ, below-MOLV order for a supplier surfaces both constraints without silently failing', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-70200', quantity: 1, supplier: 'ACME' }] } }),
  }).then((r) => r.json());
  const line = res.items[0];
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '300'); // ACME's MOLV floor (300) lifts the 1-unit line
  const kinds = line.trace.constraintPasses.map((c) => c.kind);
  assert.ok(kinds.includes('FLOOR'));
  assert.ok(kinds.includes('MIN_QTY'), 'below ACME MOQ (25) should surface, even though it never changes price');
});

test('an unknown region/salesOrg with no effective config is a clear 422, not a crash', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'ANTARCTICA', items: [{ partNumber: 'P-1', quantity: 1 }] } }),
  });
  assert.equal(res.status, 422);
});

test('getEffectiveConfig is readable by any authenticated user', async () => {
  const res = await fetch(`${BASE}/rest/config/getEffectiveConfig?region=EUROPE&salesOrg=*`, {
    headers: { Authorization: basicAuthHeader('alice') },
  });
  assert.equal(res.status, 200);
  const config = await res.json();
  assert.equal(config.region, 'EUROPE');
  assert.equal(config.version, '2026.08.0');
});

test('a PricingViewer cannot request an AI config suggestion (403)', async () => {
  const res = await fetch(`${BASE}/rest/config/suggestChange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', instruction: 'add tariff' } }),
  });
  assert.equal(res.status, 403);
});

test('a PricingAdmin can reach the AI-suggestion endpoint, which reports it has no live key rather than faking a response', async () => {
  const res = await fetch(`${BASE}/rest/config/suggestChange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('bob') },
    body: JSON.stringify({ payload: { region: 'EUROPE', instruction: 'add tariff' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'AI_NOT_CONFIGURED');
});

test('approveSuggestion and rejectSuggestion are PricingAdmin-only', async () => {
  const approve = await fetch(`${BASE}/rest/config/approveSuggestion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { suggestionId: 'x', newVersion: 'y' } }),
  });
  assert.equal(approve.status, 403);

  const reject = await fetch(`${BASE}/rest/config/rejectSuggestion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { suggestionId: 'x' } }),
  });
  assert.equal(reject.status, 403);
});

test('approveSuggestion as PricingAdmin against an unknown suggestion id is a clear 404', async () => {
  const res = await fetch(`${BASE}/rest/config/approveSuggestion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('bob') },
    body: JSON.stringify({ payload: { suggestionId: 'does-not-exist', newVersion: '2026.08.1' } }),
  });
  assert.equal(res.status, 404);
});
