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
  // Topic 4 (Appendix A): P-10023 is MTS, so freight+duty no longer apply -- just BASE(100) +
  // SCM_MARKUP(4.7) + PICK_CHARGE(21/10=2.1) = 106.8. (Was 113.8 before topic 4's stock-class
  // split; that number included freight+duty, which Europe's real MTS formula never applies.)
  assert.equal(line.result.unitPrice, '106.8');
  assert.equal(line.trace.stockClass, 'MTS'); // P-10023's recorded raw code "MTS" resolves via EUROPE's stockClassMap
  assert.equal(body.config.version, '2026.08.0');
  assert.equal(body.requestedBy, 'alice');
});

test('a raw ERP stock-class code normalizes to NonMTS via the region stockClassMap, without changing the price', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-30078', quantity: 4 }] } }),
  }).then((r) => r.json());
  const line = res.items[0];
  assert.equal(line.status, 'PRICED');
  assert.equal(line.trace.stockClass, 'NonMTS'); // P-30078's recorded raw code is "OMT"
});

test('a part whose raw stock-class code is not in the region stockClassMap comes back MISSING, not silently priced', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-90400', quantity: 1 }] } }),
  }).then((r) => r.json());
  const line = res.items[0];
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'STOCK_CLASS_UNRESOLVED');
  assert.equal(line.missing.detail, 'STOCK_CLASS_UNMAPPED:ZZZ'); // P-90400's recorded raw code "ZZZ" is deliberately absent from EUROPE's stockClassMap
});

test('topic 7: a plain price-list part (P-90600) automatically picks its cost tier by the real order quantity -- no MROQ override or special OOD needed', async () => {
  const priceP90600 = async (quantity) => {
    const res = await fetch(`${BASE}/rest/pricing/price`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
      body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-90600', quantity }] } }),
    }).then((r) => r.json());
    return res.items[0];
  };

  const below = await priceP90600(5); // below even the lowest published break (10)
  assert.equal(below.status, 'PRICED');
  assert.equal(below.trace.costCandidate.selectedBy, 'DEFAULT'); // no break matches -- falls back to the recorded default
  assert.equal(below.trace.costCandidate.value, '18.49');

  const mid = await priceP90600(30); // falls in the "25+" break
  assert.equal(mid.status, 'PRICED');
  assert.equal(mid.trace.costCandidate.selectedBy, 'USER'); // auto-selected via the same "explicit selection wins" path
  assert.equal(mid.trace.costCandidate.value, '15.41');

  const high = await priceP90600(200); // falls in the "100+" break
  assert.equal(high.status, 'PRICED');
  assert.equal(high.trace.costCandidate.value, '10.70');
});

test('a business user typing a hypothetical MROQ for an OOD=SMA part switches to the matching quantity-break cost', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-90500', quantity: 60, ood: 'SMA', mroqOverride: 60 }] } }),
  }).then((r) => r.json());
  const line = res.items[0];
  assert.equal(line.status, 'PRICED');
  // qty 60 falls in the "50+" break (12.84), not the default 18.49 — the override wins via
  // engine-core's existing "explicit user selection always wins" precedence.
  assert.equal(line.result.unitPrice, '13.79');
  assert.equal(line.trace.costCandidate.selectedBy, 'USER');
  assert.equal(line.trace.costCandidate.value, '12.84');
});

test('an MROQ override input is ignored for a non-SMA (or unspecified) OOD, but the automatic real-quantity price-list lookup still applies -- the standalone what-if is Americas-only, the price list itself is not', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-90500', quantity: 60, mroqOverride: 60 }] } }),
  }).then((r) => r.json());
  const line = res.items[0];
  assert.equal(line.status, 'PRICED');
  // The mroqOverride=60 hypothetical is ignored (no ood: 'SMA'), but the real requested
  // quantity (60) still lands in the "50+" break automatically -- same tier, different reason.
  assert.equal(line.trace.costCandidate.selectedBy, 'USER');
  assert.equal(line.trace.costCandidate.value, '12.84');
  assert.equal(line.trace.costCandidate.source.key, 'QTY_BREAK_P-90500_50'); // not MROQ_OVERRIDE_... -- confirms it took the automatic path, not the override path
});

async function priceChina(item) {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'CHINA', salesOrg: '*', items: [item] } }),
  }).then((r) => r.json());
  return res.items[0];
}

test('China route 1: OOD is JDE China -- the cost is already landed, only the 3.2% LCS markup applies', async () => {
  const line = await priceChina({ partNumber: 'CN-P001', quantity: 1, ood: 'CN' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '103.2');
});

test('China route 2 (US COO): direct from a non-LCE supplier -- freight&duty x1.32, then 3.2% markup', async () => {
  const line = await priceChina({ partNumber: 'CN-P002', quantity: 1, ood: 'SAP', supplier: 'TSS_LIVORNO', coo: 'US' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '136.22');
});

test('China route 2 (non-US COO): direct from a non-LCE supplier -- freight&duty x1.21, then 3.2% markup', async () => {
  const line = await priceChina({ partNumber: 'CN-P003', quantity: 1, ood: 'SAP', supplier: 'TSS_LIVORNO', coo: 'IT' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '124.87');
});

test('China route 3 (US COO, via LCE/SAP Europe): freight&duty, 3.2% markup, then a further 6% LCE markup', async () => {
  const line = await priceChina({ partNumber: 'CN-P004', quantity: 1, ood: 'SAP', supplier: '88058', coo: 'US' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '144.4');
});

test('China route 3 (non-US COO, via LCE/SAP Europe): same chain at the non-US freight&duty rate', async () => {
  const line = await priceChina({ partNumber: 'CN-P005', quantity: 1, ood: 'SAP', supplier: '88058', coo: 'IT' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '132.36');
});

test('the supplier "88058" (LCE) is not a real supplier-config entry -- China route branching depends only on ood/coo/supplier `when`-conditions, not supplier-config overrides', async () => {
  const line = await priceChina({ partNumber: 'CN-P004', quantity: 1, ood: 'SAP', supplier: '88058', coo: 'US' });
  assert.equal(line.trace.constraintPasses.length, 0); // no supplier-config seeded for CHINA, so no unexpected adders/constraints sneak in
});

test('China MOLV (topic 5): below-MOLV orders bump the QUANTITY, not the price -- the corrected mechanism from the newest reference sheet', async () => {
  const below = await priceChina({ partNumber: 'CN-P006', quantity: 1, ood: 'CN' });
  assert.equal(below.status, 'PRICED');
  assert.equal(below.result.unitPrice, '103.2'); // unchanged -- MOLV never touches price in QUANTITY mode
  assert.equal(below.result.quantity, 5); // ceil(500 / 103.2)
  assert.equal(below.trace.constraintPasses[0].mode, 'QUANTITY');

  const atMolv = await priceChina({ partNumber: 'CN-P006', quantity: 5, ood: 'CN' });
  assert.equal(atMolv.status, 'PRICED');
  assert.equal(atMolv.result.quantity, 5); // already at/above MOLV -- no adjustment needed
  assert.equal(atMolv.trace.constraintPasses.length, 0);
});

test('topic 8: a kit header prices as the sum of its components, each through its own full build-up', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({
      payload: {
        region: 'CHINA',
        salesOrg: '*',
        items: [
          {
            partNumber: 'CN-K001',
            quantity: 3,
            components: [
              { partNumber: 'CN-K001-A', quantity: 2, ood: 'CN' },
              { partNumber: 'CN-K001-B', quantity: 1, ood: 'CN' },
            ],
          },
        ],
      },
    }),
  }).then((r) => r.json());
  const line = res.items[0];
  assert.equal(line.status, 'PRICED');
  // CN-K001-A: 50 * 1.032 = 51.6, x2 = 103.2. CN-K001-B: 80 * 1.032 = 82.56, x1 = 82.56.
  // Header unit price (per kit) = 103.2 + 82.56 = 185.76. Requested 3 kits -- quantity carries
  // through untouched, same as any other line (extension is unitPrice x quantity elsewhere).
  assert.equal(line.result.unitPrice, '185.76');
  assert.equal(line.result.quantity, 3);
  assert.equal(line.trace.kit, true);
  assert.equal(line.trace.components.length, 2);
  assert.equal(line.trace.components[0].result.unitPrice, '51.6');
  assert.equal(line.trace.components[1].result.unitPrice, '82.56');
});

test('topic 8: a kit with an unresolvable component comes back MISSING, not silently priced off the good components', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({
      payload: {
        region: 'CHINA',
        salesOrg: '*',
        items: [
          {
            partNumber: 'CN-K002',
            quantity: 1,
            components: [
              { partNumber: 'CN-K001-A', quantity: 1, ood: 'CN' },
              { partNumber: 'CN-K002-BAD', quantity: 1, ood: 'CN' }, // deliberately unmapped stock class
            ],
          },
        ],
      },
    }),
  }).then((r) => r.json());
  const line = res.items[0];
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'KIT_COMPONENT_UNRESOLVED');
  assert.equal(line.missing.componentPartNumber, 'CN-K002-BAD');
});

test('topic 8: a kit requested for a region without a real BOM-explosion path (Europe) is a typed MISSING, not a silent wrong price', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({
      payload: {
        region: 'EUROPE',
        salesOrg: '*',
        items: [{ partNumber: 'EU-KIT', quantity: 1, components: [{ partNumber: 'P-10023', quantity: 1 }] }],
      },
    }),
  }).then((r) => r.json());
  const line = res.items[0];
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'KIT_NOT_SUPPORTED_FOR_REGION');
  assert.equal(line.missing.region, 'EUROPE');
});

async function priceRegion(region, item) {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region, salesOrg: '*', items: [item] } }),
  }).then((r) => r.json());
  return res.items[0];
}

test('topic 10: the Additional Cost flag (0-4) picks which elements apply, independent of stock class', async () => {
  // P-90700: NonMTS, base 100, freight 10, duty 5, tariff 8, pick 20 (qty 1).
  const opt0 = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 0 });
  assert.equal(opt0.status, 'PRICED');
  assert.equal(opt0.result.unitPrice, '100'); // "0 - Nothing to add" -- base cost only

  const opt1 = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 1 });
  assert.equal(opt1.result.unitPrice, '147.7'); // "1 - Landed cost & Markup" -- everything applies, same as no flag at all

  const noFlag = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1 });
  assert.equal(noFlag.result.unitPrice, '147.7'); // never setting the flag prices identically to option 1 for a NonMTS part

  const opt2 = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 2 });
  assert.equal(opt2.result.unitPrice, '104.7'); // "2 - Markup only": 100 + 4.7

  const opt3 = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 3 });
  assert.equal(opt3.result.unitPrice, '112.7'); // "3 - No Landed cost and Pick": 100 + 4.7(markup) + 8(tariff, not named so stays included)

  const opt4 = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 4 });
  assert.equal(opt4.result.unitPrice, '139.7'); // "4 - Landed cost & Markup, No tariff": 100 + 4.7 + 10 + 5 + 20
});

test('topic 10: additionalCost never forces freight/duty onto an MTS part -- stock class and the flag both have to allow it', async () => {
  // P-10023 is MTS -- freight/duty are excluded by stock class regardless of the flag.
  const line = await priceRegion('EUROPE', { partNumber: 'P-10023', quantity: 10, additionalCost: 1 });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '106.8'); // identical to the no-flag MTS price (topic 4) -- freight/duty still don't apply
});

test('topic 10: an unrecognized additionalCost value is a typed MISSING, not a guess', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 9 });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'ADDITIONAL_COST_UNRESOLVED');
  assert.equal(line.missing.detail, 'ADDITIONAL_COST_UNMAPPED:9');
});

test('India: sourced locally (OOD is IN) -- raw cost, no markup at all', async () => {
  const line = await priceRegion('INDIA', { partNumber: 'IN-P001', quantity: 1, ood: 'IN' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '50');
});

test('India: sourced overseas (OOD is not IN) -- the +40% markup applies', async () => {
  const line = await priceRegion('INDIA', { partNumber: 'IN-P002', quantity: 1, ood: 'DE' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '70'); // 50 * 1.40
});

test('Americas: MTS, local (OOD=SMA) -- LCA Handling Fee only, no freight/duty/tariff', async () => {
  const line = await priceRegion('AMERICAS', { partNumber: 'US-P001', quantity: 10, ood: 'SMA' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '110.1'); // 100 + 100*0.067(=6.7) + 34/10(=3.4)
});

test('Americas: Non-MTS, local (OOD=SMA) -- LCA Handling Fee plus freight/duty/tariff', async () => {
  const line = await priceRegion('AMERICAS', { partNumber: 'US-P002', quantity: 10, ood: 'SMA' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '127.1'); // 100 + 6.7 + (10+5+2) + 3.4
});

test('Americas: MTS, overseas (OOD != SMA) -- the higher overseas LCA Handling Fee tier applies', async () => {
  const line = await priceRegion('AMERICAS', { partNumber: 'US-P003', quantity: 10, ood: 'EU' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '113.9'); // 100 + 100*0.105(=10.5) + 3.4
});

test('Americas: Non-MTS, overseas (OOD != SMA) -- overseas LCA Handling Fee plus freight/duty/tariff', async () => {
  const line = await priceRegion('AMERICAS', { partNumber: 'US-P004', quantity: 10, ood: 'EU' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '130.9'); // 100 + 10.5 + 17 + 3.4
});

test('Americas: effective-dated LCA Handling Fee -- the real 6.2%->6.7% (Jan 2026) rate change reprices historical dates correctly', async () => {
  const before = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'AMERICAS', salesOrg: '*', priceDate: '2025-08-01', items: [{ partNumber: 'US-P001', quantity: 10, ood: 'SMA' }] } }),
  }).then((r) => r.json());
  assert.equal(before.items[0].result.unitPrice, '109.6'); // 100 + 100*0.062(=6.2) + 3.4, the pre-Jan-2026 rate
  assert.equal(before.config.version, '2025.06.0');

  const after = await priceRegion('AMERICAS', { partNumber: 'US-P001', quantity: 10, ood: 'SMA' }); // defaults to today (2026-08-25)
  assert.equal(after.result.unitPrice, '110.1'); // the current 6.7% rate
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
