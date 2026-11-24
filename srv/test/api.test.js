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
  // SCM_MARKUP(4.8) x 6% anticipated cost increase + PICK_CHARGE(21/10=2.1) = 113.19. (Was 113.8 before topic 4's stock-class
  // split; that number included freight+duty, which Europe's real MTS formula never applies.)
  assert.equal(line.result.unitPrice, '113.19');
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

test('EUROPE Non-MTS cost resolves via CCD (PIR data) first, per the stock-class-aware access sequence', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-30078', quantity: 4 }] } }),
  }).then((r) => r.json());
  const line = res.items[0];
  assert.equal(line.status, 'PRICED');
  assert.equal(line.trace.costCandidate.source.system, 'CCD'); // PIR data, downloaded from SAP ERP but held for consumption in BI as CCD
  assert.equal(line.trace.costCandidate.selectedBy, 'ACCESS_SEQUENCE:CCD');
});

test('fetchItemAttributes resolves stock class up front -- supplier/warehouse stay user input until C4C is wired', async () => {
  // Owner decision (2026-08-26): itemAttributes seeds were removed from the recorded data so
  // supplier/warehouse/supplier-country are typed by the user for now, to make the logic
  // legible -- the endpoint + facts.itemAttributes mechanism stay as the future C4C hook.
  const res = await fetch(`${BASE}/rest/pricing/fetchItemAttributes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'EU-T100' }, { partNumber: 'P-10023' }] } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.attributes['EU-T100'], {
    supplier: null, supplierCountry: null, warehouse: null, stockClass: 'NonMTS', stockClassError: null,
  });
  assert.equal(body.attributes['P-10023'].stockClass, 'MTS');
});

test('fetchItemAttributes never prices -- a caller-supplied supplier passes through and resolves its country from supplier master data', async () => {
  const res = await fetch(`${BASE}/rest/pricing/fetchItemAttributes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'EU-T100', supplier: 'GLOBEX' }] } }),
  }).then((r) => r.json());
  assert.equal(res.attributes['EU-T100'].supplier, 'GLOBEX');
  assert.equal(res.attributes['EU-T100'].supplierCountry, 'NL'); // from GLOBEX's supplier-config
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
  assert.equal(line.result.unitPrice, '14.61');
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

test('China route 2 (US supplier country): direct from a non-LCE supplier -- freight&duty x1.32, then 3.2% markup', async () => {
  const line = await priceChina({ partNumber: 'CN-P002', quantity: 1, ood: 'SAP', supplier: 'TSS_LIVORNO', supplierCountry: 'US' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '136.22');
});

test('China route 2 (non-US supplier country): direct from a non-LCE supplier -- freight&duty x1.21, then 3.2% markup', async () => {
  const line = await priceChina({ partNumber: 'CN-P003', quantity: 1, ood: 'SAP', supplier: 'TSS_LIVORNO', supplierCountry: 'IT' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '124.87');
});

test('China route 3 (US supplier country, via LCE/SAP Europe): freight&duty, 3.2% markup, then a further 6% LCE markup', async () => {
  const line = await priceChina({ partNumber: 'CN-P004', quantity: 1, ood: 'SAP', supplier: '88058', supplierCountry: 'US' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '144.4');
});

test('China route 3 (non-US supplier country, via LCE/SAP Europe): same chain at the non-US freight&duty rate', async () => {
  const line = await priceChina({ partNumber: 'CN-P005', quantity: 1, ood: 'SAP', supplier: '88058', supplierCountry: 'IT' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '132.36');
});

test('the supplier "88058" (LCE) is not a real supplier-config entry -- China route branching depends only on ood/supplierCountry/supplier `when`-conditions, not supplier-config overrides', async () => {
  const line = await priceChina({ partNumber: 'CN-P004', quantity: 1, ood: 'SAP', supplier: '88058', supplierCountry: 'US' });
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
  // P-90700: NonMTS, base 100, freight 10%, duty 5%, tariff 8% (rates on base+markup=104.7), pick 20 (qty 1).
  const opt0 = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 0 });
  assert.equal(opt0.status, 'PRICED');
  assert.equal(opt0.result.unitPrice, '100'); // "0 - Nothing to add" -- base cost only

  const opt1 = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 1 });
  assert.equal(opt1.result.unitPrice, '157.64'); // "1 - Landed cost & Markup": 100 + 4.7 + 10.47 + 5.235 + 8.376 + 20

  const noFlag = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1 });
  assert.equal(noFlag.result.unitPrice, '157.64'); // never setting the flag prices identically to option 1 for a NonMTS part

  const opt2 = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 2 });
  assert.equal(opt2.result.unitPrice, '111.09'); // "2 - Markup only": 100 + 4.7

  const opt3 = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 3 });
  assert.equal(opt3.result.unitPrice, '119.98'); // "3 - No Landed cost and Pick": 100 + 4.7(markup) + 8.376(tariff 8% of 104.7, not named so stays included)

  const opt4 = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 4 });
  assert.equal(opt4.result.unitPrice, '148.75'); // "4 - Landed cost & Markup, No tariff": 100 + 4.7 + 10.47 + 5.235 + 20
});

test('topic 10: additionalCost never forces freight/duty onto an MTS part -- stock class and the flag both have to allow it', async () => {
  // P-10023 is MTS -- freight/duty are excluded by stock class regardless of the flag.
  const line = await priceRegion('EUROPE', { partNumber: 'P-10023', quantity: 10, additionalCost: 1 });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '113.19'); // identical to the no-flag MTS price (topic 4) -- freight/duty still don't apply
});

test('topic 10: an unrecognized additionalCost value is a typed MISSING, not a guess', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 9 });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'ADDITIONAL_COST_UNRESOLVED');
  assert.equal(line.missing.detail, 'ADDITIONAL_COST_UNMAPPED:9');
});

test('India: local supplier (supplierCountry IN) -- raw cost, no markup at all', async () => {
  const line = await priceRegion('INDIA', { partNumber: 'IN-P001', quantity: 1, supplierCountry: 'IN' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '50');
});

test('India: overseas supplier (or unresolved supplier country) -- the +40% markup applies, conservatively', async () => {
  const overseas = await priceRegion('INDIA', { partNumber: 'IN-P002', quantity: 1, supplierCountry: 'DE' });
  assert.equal(overseas.status, 'PRICED');
  assert.equal(overseas.result.unitPrice, '70'); // 50 * 1.40

  const unknown = await priceRegion('INDIA', { partNumber: 'IN-P002', quantity: 1 }); // no supplier country at all
  assert.equal(unknown.result.unitPrice, '70', 'an unresolved supplier country falls in the overseas branch -- the higher rate, never a silent under-price');
});

test('Americas: MTS, US supplier -- LCA Handling Fee only, no freight/duty/tariff', async () => {
  const line = await priceRegion('AMERICAS', { partNumber: 'US-P001', quantity: 10, supplierCountry: 'US' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '110.1'); // 100 + 100*0.067(=6.7) + 34/10(=3.4)
});

test('Americas: Non-MTS, US supplier -- LCA Handling Fee plus freight/duty/tariff', async () => {
  const line = await priceRegion('AMERICAS', { partNumber: 'US-P002', quantity: 10, supplierCountry: 'US' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '128.24'); // 100 + 6.7 + 106.7*(0.10+0.05+0.02)(=18.139) + 3.4
});

test('Americas: MTS, overseas supplier -- the higher overseas LCA Handling Fee tier applies', async () => {
  const line = await priceRegion('AMERICAS', { partNumber: 'US-P003', quantity: 10, supplierCountry: 'CN' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '113.9'); // 100 + 100*0.105(=10.5) + 3.4
});

test('Americas: Non-MTS, overseas supplier -- overseas LCA Handling Fee plus freight/duty/tariff', async () => {
  const line = await priceRegion('AMERICAS', { partNumber: 'US-P004', quantity: 10, supplierCountry: 'CN' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '132.69'); // 100 + 10.5 + 110.5*(0.10+0.05+0.02)(=18.785) + 3.4
});

test('Americas: supplierCountry resolves from supplier-config when the item only names a supplier', async () => {
  const line = await priceRegion('AMERICAS', { partNumber: 'US-P001', quantity: 10, supplier: 'US-ACME' });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.unitPrice, '110.1', 'US-ACME is seeded with supplierCountry US, so the local 6.7% rate applies without the caller sending a country');
});

test('Americas: effective-dated LCA Handling Fee -- the real 6.2%->6.7% (Jan 2026) rate change reprices historical dates correctly', async () => {
  const before = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'AMERICAS', salesOrg: '*', priceDate: '2025-08-01', items: [{ partNumber: 'US-P001', quantity: 10, supplierCountry: 'US' }] } }),
  }).then((r) => r.json());
  assert.equal(before.items[0].result.unitPrice, '109.6'); // 100 + 100*0.062(=6.2) + 3.4, the pre-Jan-2026 rate
  assert.equal(before.config.version, '2025.06.0');

  const after = await priceRegion('AMERICAS', { partNumber: 'US-P001', quantity: 10, supplierCountry: 'US' }); // defaults to today
  assert.equal(after.result.unitPrice, '110.1'); // the current 6.7% rate
});

test('a supplier override changes freight/duty/tariff/MOLV/MOQ, applied over the generic API6 elements', async () => {
  const withoutSupplier = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-70200', quantity: 10 }] } }),
  }).then((r) => r.json());
  assert.equal(withoutSupplier.items[0].status, 'PRICED');
  assert.equal(withoutSupplier.items[0].result.unitPrice, '182.4'); // generic rates: 157.05 + 157.05*(0.06+0.022+0) + 21/10

  const withAcme = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-70200', quantity: 30, supplier: 'ACME', warehouse: 'EU01' }] } }),
  }).then((r) => r.json());
  assert.equal(withAcme.items[0].status, 'PRICED');
  assert.equal(withAcme.items[0].result.unitPrice, '233.15'); // ACME's EU01-warehouse rates (18%/9.5%/12% on 157.05), quantity above the part's MOQ so no constraint fires
  assert.equal(withAcme.items[0].trace.constraintPasses.length, 0);
});

test('freight/duty/tariff are per-warehouse, not supplier-wide -- the same supplier prices differently depending on which warehouse the goods ship to', async () => {
  // P-70200: base 150, NonMTS (CMT), qty 30 -> basis = base+4.7% = 157.05, pick 21/30 = 0.7;
  // freight/duty/tariff are RATES on that basis.
  const noWarehouse = await priceRegion('EUROPE', { partNumber: 'P-70200', quantity: 30, supplier: 'ACME' });
  assert.equal(noWarehouse.result.unitPrice, '181'); // no warehouse named -- falls back to the generic API6 rates (6%/2.2%/0), same as no supplier at all

  const euWarehouse = await priceRegion('EUROPE', { partNumber: 'P-70200', quantity: 30, supplier: 'ACME', warehouse: 'EU01' });
  assert.equal(euWarehouse.result.unitPrice, '233.15'); // ACME's EU01 rates (18%/9.5%/12%)

  const usWarehouse = await priceRegion('EUROPE', { partNumber: 'P-70200', quantity: 30, supplier: 'ACME', warehouse: 'US01' });
  assert.equal(usWarehouse.result.unitPrice, '267.31'); // same supplier, US01 rates (25%/15%/20%) -- a genuinely different landed cost for the same goods, same supplier
});

test('a below-MOQ, below-MOLV order surfaces both constraints without silently failing -- MOLV from the supplier, MOQ from the part\'s own facts', async () => {
  // MOQ is deliberately NOT a supplier-config field (owner: "MOQ is not based on the
  // supplier, its based on the order") -- P-70200's own facts declare moq=25, independent of
  // which supplier (if any) is on the line; MOLV (300) still comes from ACME's supplier-config.
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
  assert.ok(kinds.includes('MIN_QTY'), 'below the part\'s own MOQ (25) should surface, even though it never changes price');
});

test('an unknown region/salesOrg with no effective config is a clear 422, not a crash', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'ANTARCTICA', items: [{ partNumber: 'P-1', quantity: 1 }] } }),
  });
  assert.equal(res.status, 422);
});

test('getEffectiveConfig is readable by a PricingAdmin (and by no one else -- see the role-model tests)', async () => {
  const res = await fetch(`${BASE}/rest/config/getEffectiveConfig?region=EUROPE&salesOrg=*`, {
    headers: { Authorization: basicAuthHeader('bob') },
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

async function priceRaw(payload) {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload }),
  });
  return { status: res.status, body: await res.json() };
}

test('C4C payload review: omitting region derives it from customerOod via region-route (explicit region still wins when given)', async () => {
  const { status, body } = await priceRaw({ salesOrg: '*', customerOod: 'SAP', items: [{ partNumber: 'P-10023', quantity: 10 }] });
  assert.equal(status, 200);
  assert.equal(body.region.value, 'EUROPE');
  assert.equal(body.region.derivedBy, 'ROUTE:SAP');
  assert.equal(body.region.entityLabel, 'TSS Germany');

  const explicit = await priceRaw({ region: 'EUROPE', salesOrg: '*', customerOod: 'CN', items: [{ partNumber: 'P-10023', quantity: 10 }] });
  assert.equal(explicit.body.region.value, 'EUROPE');
  assert.equal(explicit.body.region.derivedBy, 'EXPLICIT', 'an explicit region always wins over a customerOod that would route elsewhere');
});

test('C4C payload review: region also derives from customerId via party-config, without the caller ever sending an ood', async () => {
  const { status, body } = await priceRaw({ salesOrg: '*', customerId: 'CUST-US-002', items: [{ partNumber: 'US-P001', quantity: 5 }] });
  assert.equal(status, 200);
  assert.equal(body.region.value, 'AMERICAS');
  assert.equal(body.region.derivedBy, 'ROUTE:SMA');
});

test('C4C payload review: an explicit payload.customerOod overrides party-config\'s stored ood for that customer, same override precedence as everywhere else', async () => {
  const { body } = await priceRaw({ salesOrg: '*', customerId: 'CUST-US-002', customerOod: 'SAP', items: [{ partNumber: 'P-10023', quantity: 5 }] });
  assert.equal(body.region.value, 'EUROPE');
  assert.equal(body.region.derivedBy, 'ROUTE:SAP');
});

test('C4C payload review: no region, no customerId/customerOod, and no route match are all typed 400/422, never a silent guess', async () => {
  const missingBoth = await priceRaw({ salesOrg: '*', items: [{ partNumber: 'P-10023', quantity: 1 }] });
  assert.equal(missingBoth.status, 400);

  const unmapped = await priceRaw({ salesOrg: '*', customerOod: 'ZZZ', items: [{ partNumber: 'P-10023', quantity: 1 }] });
  assert.equal(unmapped.status, 400);
});

async function callConfigAction(action, user, payload) {
  const res = await fetch(`${BASE}/rest/config/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(user) },
    body: JSON.stringify({ payload }),
  });
  return { status: res.status, body: await res.json() };
}

test('direct config edits (saveRegionConfig/saveSupplierConfig/saveRegionRoute/savePartyConfig) are PricingAdmin-only', async () => {
  const asAlice = await Promise.all([
    callConfigAction('saveRegionConfig', 'alice', { region: 'EUROPE', salesOrg: 'DE99', version: 'x' }),
    callConfigAction('saveSupplierConfig', 'alice', { supplier: 'X', version: 'x' }),
    callConfigAction('saveRegionRoute', 'alice', { ood: 'ZZ', salesOrg: '*', region: 'EUROPE', version: 'x' }),
    callConfigAction('savePartyConfig', 'alice', { customerId: 'CUST-X', version: 'x' }),
  ]);
  for (const r of asAlice) assert.equal(r.status, 403);
});

test('a PricingAdmin can save a brand-new region-config version, and pricing picks it up immediately -- no restart needed', async () => {
  const doc = {
    region: 'EUROPE',
    salesOrg: 'DE99', // a fresh sales-org-specific document -- doesn't touch the "*" default other tests rely on
    version: 'DE99-2026.08.0',
    status: 'ACTIVE',
    validFrom: '2026-08-01',
    resolution: [{ id: 'RES_TEST', costBasis: 'STANDARD' }],
    buildUp: [
      { id: 'BASE_COST', type: 'BASE' },
      { id: 'FLAT_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.10 },
    ],
  };
  const { status, body } = await callConfigAction('saveRegionConfig', 'bob', doc);
  assert.equal(status, 200);
  assert.equal(body.version, 'DE99-2026.08.0');
  assert.equal(body.provenance.source, 'HUMAN', 'provenance is stamped server-side, never trusted from the payload');
  assert.equal(body.provenance.authoredBy, 'bob');

  const sanity = await priceRegion('EUROPE', { partNumber: 'P-10023', quantity: 1 }); // the unrelated "*" default config still prices fine too
  assert.equal(sanity.status, 'PRICED');

  // price against the new DE99-specific config directly, proving the edit is live immediately -- no restart needed
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: 'DE99', items: [{ partNumber: 'P-10023', quantity: 1 }] } }),
  }).then((r) => r.json());
  assert.equal(res.items[0].status, 'PRICED');
  assert.equal(res.items[0].result.unitPrice, '110'); // 100 base * 1.10 -- from the just-saved config, not the "*" default
});

test('saveRegionConfig rejects an invalid document (FACTOR with no basis) with a clear 422, and never touches the store', async () => {
  const before = await fetch(`${BASE}/rest/config/listVersions?region=EUROPE&salesOrg=DE98`, {
    headers: { Authorization: basicAuthHeader('bob') },
  }).then((r) => r.json());
  assert.equal(before.versions.length, 0);

  const { status } = await callConfigAction('saveRegionConfig', 'bob', {
    region: 'EUROPE',
    salesOrg: 'DE98',
    version: 'bad-1',
    buildUp: [{ id: 'BASE_COST', type: 'BASE' }, { id: 'BAD_FACTOR', type: 'FACTOR' }], // FACTOR with no basis
  });
  assert.equal(status, 422);

  const after = await fetch(`${BASE}/rest/config/listVersions?region=EUROPE&salesOrg=DE98`, {
    headers: { Authorization: basicAuthHeader('bob') },
  }).then((r) => r.json());
  assert.equal(after.versions.length, 0, 'a rejected save leaves the store completely untouched');
});

test('a PricingAdmin can save supplier-config, region-route, and party-config directly', async () => {
  const supplier = await callConfigAction('saveSupplierConfig', 'bob', {
    supplier: 'DIRECTEDIT', version: 'v1', validFrom: '2026-08-01', warehouses: { EU01: { freight: '7.50' } },
  });
  assert.equal(supplier.status, 200);
  assert.equal(supplier.body.warehouses.EU01.freight, '7.50');

  const route = await callConfigAction('saveRegionRoute', 'bob', {
    ood: 'ZZ', salesOrg: '*', region: 'EUROPE', entityLabel: 'Test Entity', version: 'v1', validFrom: '2026-08-01',
  });
  assert.equal(route.status, 200);
  assert.equal(route.body.region, 'EUROPE');

  const party = await callConfigAction('savePartyConfig', 'bob', {
    customerId: 'CUST-DIRECT-EDIT', version: 'v1', validFrom: '2026-08-01', territory: 'TEST', customerOod: 'SAP',
  });
  assert.equal(party.status, 200);
  assert.equal(party.body.customerOod, 'SAP');
});

// Verification parts: one per region, all with a STATIC 100.00 base cost and round charge
// values, so every factor the config applies is directly readable in the result. These are
// the numbers the owner verifies the config against by hand.
test('EU-T100: 100 + 4.8% markup + 10%/5%/8% freight/duty/tariff on 104.8, +6% anticipated cost increase, + 21/10 pick = 138.74 EUR', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10 });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.trace.costCandidate.value, '100.00');
  assert.equal(line.trace.stockClass, 'NonMTS');
  assert.equal(line.result.unitPrice, '138.74');
});

test('CN-T100: JDE China route = 100 × 1.032 = 103.2 CNY; SAP route (US supplier country) = 136.22 CNY', async () => {
  const jde = await priceChina({ partNumber: 'CN-T100', quantity: 1, ood: 'CN' });
  assert.equal(jde.status, 'PRICED');
  assert.equal(jde.result.unitPrice, '103.2');

  const sap = await priceChina({ partNumber: 'CN-T100', quantity: 1, ood: 'SAP', supplier: 'TSS_LIVORNO', supplierCountry: 'US' });
  assert.equal(sap.status, 'PRICED');
  assert.equal(sap.result.unitPrice, '136.22'); // 100 + 32 (×1.32 F&D) + 3.2% on 132
});

test('IN-T100: local supplier = 100 INR flat; overseas (or unresolved) supplier = 140 INR (+40%)', async () => {
  const local = await priceRegion('INDIA', { partNumber: 'IN-T100', quantity: 1, supplierCountry: 'IN' });
  assert.equal(local.status, 'PRICED');
  assert.equal(local.result.unitPrice, '100');

  const overseas = await priceRegion('INDIA', { partNumber: 'IN-T100', quantity: 1 });
  assert.equal(overseas.status, 'PRICED');
  assert.equal(overseas.result.unitPrice, '140');
});

test('US-T100: US supplier = 100 + 6.7% LCA + 10%/5%/8% f/d/t on 106.7 + 34/10 pick = 134.64 USD; overseas = 139.32 USD', async () => {
  const domestic = await priceRegion('AMERICAS', { partNumber: 'US-T100', quantity: 10, supplierCountry: 'US' });
  assert.equal(domestic.status, 'PRICED');
  assert.equal(domestic.trace.stockClass, 'NonMTS');
  assert.equal(domestic.result.unitPrice, '134.64');

  const overseas = await priceRegion('AMERICAS', { partNumber: 'US-T100', quantity: 10 });
  assert.equal(overseas.status, 'PRICED');
  assert.equal(overseas.result.unitPrice, '139.32'); // 10.5% LCA instead of 6.7%, and the f/d/t rates apply on the larger 110.5 basis
});

test('listSuppliers returns every supplier globally, independent of region', async () => {
  const res = await fetch(`${BASE}/rest/config/listSuppliers`, {
    headers: { Authorization: basicAuthHeader('bob') },
  });
  assert.equal(res.status, 200);
  const { suppliers } = await res.json();
  const ids = suppliers.map((s) => s.supplier);
  // Other tests in this run may add suppliers (e.g. DIRECTEDIT) — assert the seeded ones
  // are present, not that they're alone.
  for (const expected of ['ACME', 'GLOBEX', 'INITECH', 'US-ACME']) assert.ok(ids.includes(expected), `missing ${expected}`);
  const initech = suppliers.find((s) => s.supplier === 'INITECH');
  assert.equal(initech.warehouses.EU01.tariff, '0.2'); // a RATE: 20%
  assert.equal(initech.supplierCountry, 'CN');
});

test('same part shipped to the same warehouse via three different suppliers — three different landed costs, driven by the supplier\'s per-warehouse terms, not the region', async () => {
  // EU-T100 qty 10, NonMTS: 100 + 4.7 markup + supplier freight + duty + tariff + 2 pick.
  const acme = await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10, supplier: 'ACME', warehouse: 'EU01' });
  assert.equal(acme.result.unitPrice, '157.07'); // 104.7 * (0.18+0.095+0.12) = 41.36

  const globex = await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10, supplier: 'GLOBEX', warehouse: 'EU01' });
  assert.equal(globex.result.unitPrice, '132.07'); // 104.7 * (0.08+0.04+0.05) = 17.8

  const initech = await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10, supplier: 'INITECH', warehouse: 'EU01' });
  assert.equal(initech.result.unitPrice, '155.4'); // 104.7 * (0.12+0.06+0.2) = 39.79

  const none = await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10 });
  assert.equal(none.result.unitPrice, '138.74'); // no supplier -> the part's own generic rates (10%/5%/8%)
});

test('the same supplier (ACME) prices the same part differently depending on the destination warehouse', async () => {
  const toEurope = await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10, supplier: 'ACME', warehouse: 'EU01' });
  assert.equal(toEurope.result.unitPrice, '157.07'); // ACME's EU01 rates (18%/9.5%/12%)

  const toAmericas = await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10, supplier: 'ACME', warehouse: 'US01' });
  assert.equal(toAmericas.result.unitPrice, '179.84'); // same ACME, US01 rates (25%/15%/20%) -- ships the same goods, different landed cost

  const noWarehouse = await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10, supplier: 'ACME' });
  assert.equal(noWarehouse.result.unitPrice, '138.74'); // ACME named but no warehouse -- falls back to the part's own generic rates
});

test('getEffectiveRegionRoute and getEffectivePartyConfig are readable by a PricingAdmin', async () => {
  const route = await fetch(`${BASE}/rest/config/getEffectiveRegionRoute?ood=SAP&salesOrg=*`, {
    headers: { Authorization: basicAuthHeader('bob') },
  });
  assert.equal(route.status, 200);
  const routeBody = await route.json();
  assert.equal(routeBody.region, 'EUROPE');
  assert.equal(routeBody.entityLabel, 'TSS Germany');

  const party = await fetch(`${BASE}/rest/config/getEffectivePartyConfig?customerId=CUST-DE-001`, {
    headers: { Authorization: basicAuthHeader('bob') },
  });
  assert.equal(party.status, 200);
  const partyBody = await party.json();
  assert.equal(partyBody.customerOod, 'SAP');
  assert.equal(partyBody.territory, 'DACH');
});

// --- Pricing types (owner decision 2026-11-24): COST_PLUS and PRICE_LIST only ---

test('PRICE_LIST sources the cost from the supplier price list; the normal build-up still applies on top', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [
      { partNumber: 'EU-T100', quantity: 10, supplier: 'ACME', pricingType: 'PRICE_LIST' },
    ] } }),
  });
  assert.equal(res.status, 200);
  const [line] = (await res.json()).items;
  assert.equal(line.status, 'PRICED');
  // Price-list cost 90.00 (ACME list, minQty-1 tier) replaces the ERP/CCD 100.00, then the
  // normal NonMTS build-up applies: 90 + 4.7% = 94.23, + freight 10% + duty 5% + tariff 8%
  // of 94.23 (= 9.423 + 4.7115 + 7.5384), + pick 20/10 = 2 -> 117.9029 -> 117.9.
  assert.equal(line.result.unitPrice, '125.07');
  assert.equal(line.trace.costCandidate.source.system, 'PRICE_LIST');
  assert.equal(line.trace.costCandidate.source.field, 'SUPPLIER:ACME'); // which key matched -- never silent
  assert.equal(line.trace.costCandidate.selectedBy, 'USER'); // explicit per-line selection, same precedence as always
});

test('PRICE_LIST falls back from supplier to product category for the lookup key', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [
      { partNumber: 'P-10023', quantity: 1, productCategory: 'SEALS', pricingType: 'PRICE_LIST' },
    ] } }),
  });
  const [line] = (await res.json()).items;
  assert.equal(line.status, 'PRICED');
  // Category list cost 80.00; P-10023 is MTS so no freight/duty/tariff:
  // 80 + 4.7% (3.76) + pick 21/1 (21) = 104.76.
  assert.equal(line.result.unitPrice, '109.87');
  assert.equal(line.trace.costCandidate.source.field, 'CATEGORY:SEALS');
});

test('a PRICE_LIST line with no matching list is a typed MISSING naming every key tried -- never a silent fall-back to COST_PLUS', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [
      { partNumber: 'P-20045', quantity: 1, supplier: 'GLOBEX', pricingType: 'PRICE_LIST' },
      { partNumber: 'P-20045', quantity: 1, pricingType: 'PRICE_LIST' },
    ] } }),
  });
  const [withSupplier, withNoKey] = (await res.json()).items;
  assert.equal(withSupplier.status, 'MISSING');
  assert.equal(withSupplier.missing.reason, 'PRICE_LIST_COST_NOT_FOUND');
  assert.equal(withSupplier.missing.detail, 'TRIED:SUPPLIER:GLOBEX');
  assert.equal(withNoKey.status, 'MISSING');
  assert.equal(withNoKey.missing.detail, 'NO_SUPPLIER_OR_PRODUCT_CATEGORY');
});

test('an unsupported pricing type is a typed MISSING; unset defaults to COST_PLUS unchanged', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [
      { partNumber: 'P-10023', quantity: 10, pricingType: 'VARIANT' },
      { partNumber: 'P-10023', quantity: 10 },
    ] } }),
  });
  const [variant, plain] = (await res.json()).items;
  assert.equal(variant.status, 'MISSING');
  assert.equal(variant.missing.reason, 'PRICING_TYPE_UNSUPPORTED');
  assert.match(variant.missing.detail, /VARIANT/);
  assert.equal(plain.status, 'PRICED');
  assert.equal(plain.result.unitPrice, '113.19'); // byte-identical to the pre-pricing-type behavior
});

test('an OPPORTUNITY is cost only: the result carries landedCost and never a price or margin', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', hostObjectType: 'OPPORTUNITY', items: [
      { partNumber: 'EU-T100', quantity: 10 },
    ] } }),
  });
  const body = await res.json();
  assert.equal(body.costOnly, true);
  const [line] = body.items;
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.landedCost, '138.74');
  assert.equal(line.result.unitPrice, undefined);
  assert.equal(line.result.price, undefined);
  assert.equal(line.result.margin, undefined);
});

test('the configured cost access sequence drives per-source WSO2 endpoint calls, and the walk is visible in the trace', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [
      { partNumber: 'P-50099', quantity: 5 },
    ] } }),
  });
  const [line] = (await res.json()).items;
  assert.equal(line.status, 'PRICED');
  // P-50099 has no C4C or ERP cost on file -- the walk must show both endpoints tried and
  // empty before CCD answered, and must stop there (CCP never called).
  assert.deepEqual(line.trace.costRouting, {
    sequence: ['C4C', 'ERP', 'CCD', 'CCP'],
    calls: [
      { system: 'C4C', endpoint: '/costs/c4c', found: 0 },
      { system: 'ERP', endpoint: '/costs/erp', found: 0 },
      { system: 'CCD', endpoint: '/costs/ccd', found: 1 },
    ],
  });
  assert.equal(line.trace.costCandidate.selectedBy, 'ACCESS_SEQUENCE:CCD');
});

// --- Phase 2 role model (owner spec 2026-11-24): PricingViewer = pricing only, PricingAdmin = + config ---

test('a PricingViewer gets 403 on EVERY config endpoint, reads included', async () => {
  for (const url of [
    `${BASE}/rest/config/getEffectiveConfig?region=EUROPE&salesOrg=*`,
    `${BASE}/rest/config/listSuppliers`,
    `${BASE}/rest/config/listVersions?region=EUROPE&salesOrg=*`,
  ]) {
    const res = await fetch(url, { headers: { Authorization: basicAuthHeader('alice') } });
    assert.equal(res.status, 403, `${url} must be unreachable for a viewer`);
  }
});

test('an authenticated user with NEITHER role gets 403 on the pricing API too -- service-level enforcement, not UI hiding', async () => {
  const priced = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('carol') },
    body: JSON.stringify({ payload: { region: 'EUROPE', items: [{ partNumber: 'P-10023', quantity: 1 }] } }),
  });
  assert.equal(priced.status, 403);

  const attrs = await fetch(`${BASE}/rest/pricing/fetchItemAttributes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('carol') },
    body: JSON.stringify({ payload: { region: 'EUROPE', items: [{ partNumber: 'P-10023', quantity: 1 }] } }),
  });
  assert.equal(attrs.status, 403);
});

test('a PricingAdmin has everything the viewer has: bob can price', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('bob') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-10023', quantity: 10 }] } }),
  });
  assert.equal(res.status, 200);
  const [line] = (await res.json()).items;
  assert.equal(line.result.unitPrice, '113.19');
});

// --- Phase 3 backend hooks: /me for UI routing, read-only price-list lookup for the Admin tab ---

test('me returns the caller identity and both role flags, for any authenticated user', async () => {
  const me = (user) => fetch(`${BASE}/rest/pricing/me`, { headers: { Authorization: basicAuthHeader(user) } }).then((r) => r.json());
  assert.deepEqual((await me('alice')).roles, { PricingViewer: true, PricingAdmin: false });
  assert.deepEqual((await me('bob')).roles, { PricingViewer: true, PricingAdmin: true });
  assert.deepEqual((await me('carol')).roles, { PricingViewer: false, PricingAdmin: false });
  const unauthenticated = await fetch(`${BASE}/rest/pricing/me`);
  assert.equal(unauthenticated.status, 401);
});

test('lookupPriceList is a read-only browser over the WSO2 price-list lookup, PricingAdmin only', async () => {
  const hit = await fetch(`${BASE}/rest/config/lookupPriceList?region=EUROPE&supplier=ACME&partNumber=EU-T100&quantity=60`, {
    headers: { Authorization: basicAuthHeader('bob') },
  });
  assert.equal(hit.status, 200);
  const body = await hit.json();
  assert.equal(body.matchedBy, 'SUPPLIER:ACME');
  assert.equal(body.entry.value, '85.00'); // qty 60 -> the minQty-50 tier

  const asViewer = await fetch(`${BASE}/rest/config/lookupPriceList?region=EUROPE&supplier=ACME&partNumber=EU-T100&quantity=60`, {
    headers: { Authorization: basicAuthHeader('alice') },
  });
  assert.equal(asViewer.status, 403);
});

// --- Phase 5: C4C write-back endpoint ---

test('writeBackToC4C is a Viewer capability; dev (tenant+user defaulted, no password) answers typed C4C_CREDENTIALS_MISSING', async () => {
  const res = await fetch(`${BASE}/rest/pricing/writeBackToC4C`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { objectType: 'QUOTE', objectId: 'Q-1', items: [{ partNumber: 'EU-T100', landedCost: '130.78' }] } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'C4C_CREDENTIALS_MISSING'); // typed, never a faked success (URL+user default to the QUA tenant; password is env-only)

  const noRole = await fetch(`${BASE}/rest/pricing/writeBackToC4C`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('carol') },
    body: JSON.stringify({ payload: { objectType: 'QUOTE', objectId: 'Q-1', items: [{ partNumber: 'X' }] } }),
  });
  assert.equal(noRole.status, 403);
});

// --- C4C facade: the exact contract the ABSL retrivePriceBI / getPricePoints scripts speak ---

test('getCustomerPriceList accepts the raw ABSL payload and answers the calculatedPriceList contract', async () => {
  const res = await fetch(`${BASE}/rest/pricing/getCustomerPriceList`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') }, // Viewer role is enough
    body: JSON.stringify({
      requestorId: 'X_WSO2_READ',
      customer: { customerId: '100233', originOfData: 'SAP', countryCode: 'DE', custcurrency: 'EUR', quoteId: '140981' },
      item: [
        // OOD SAP -> EUROPE via region-route; OMT -> NonMTS via EUROPE's stockClassMap;
        // supplier+warehouse terms apply -> the long-pinned ACME@EU01 value.
        { lineId: '10', itemLongNumber: 'EU-T100', salesQuantity: '10', stockClassGroupCode: 'OMT', supplierExternalID: 'ACME', supplierCountryCode: 'DE', warehouseCode: 'EU01', c4cUnitPriceAmt: '', priceCurrencyCode: 'EUR' },
        // Existing C4C price must be PRESERVED (no margin rule in the engine yet), margin computed against it.
        { lineId: '20', itemLongNumber: 'P-10023', salesQuantity: '10', stockClassGroupCode: 'MTS', c4cUnitPriceAmt: '155.00', priceCurrencyCode: 'EUR' },
        // Unknown part -> typed miss, zeros on cost, nothing invented.
        { lineId: '30', itemLongNumber: 'NO-SUCH-PART', salesQuantity: '1', stockClassGroupCode: 'MTS' },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'SUCCESS'); // the ABSL's success check is Content.Contains("SUCCESS")
  const [l10, l20, l30] = body.calculatedPriceList;

  assert.equal(l10.lineId, '10');
  assert.equal(l10.costPlusUnitAmt, '157.07');
  assert.equal(l10.costFechedFrom, 'CCD');
  assert.equal(l10.messageCode, 'M1'); // the ABSL's own "cost from CCD" convention
  assert.match(l10.explainCostDesc, /SCM_MARKUP \+4\.80/);
  assert.match(l10.explainCostDesc, /ANTICIPATED_COST_INCREASE \+8\.77/); // 6 % of 146.196 (cost + markup + freight + duty + tariff)
  assert.match(l10.explainCostDesc, /config 2026\.08\.0/);

  assert.equal(l20.costPlusUnitAmt, '113.19');
  assert.equal(l20.c4cPriceMultipliedAmt, '155.00'); // never destroys an existing C4C price
  assert.equal(l20.gpamt, '0.2697');

  assert.equal(l30.costPlusUnitAmt, '0');
  assert.match(l30.explainCostDesc, /NO_CANDIDATES/);
});

test('getCustomerPriceList answers FAILED (HTTP 200) for an unroutable originOfData — the ABSL error branch, not a 4xx', async () => {
  const res = await fetch(`${BASE}/rest/pricing/getCustomerPriceList`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ customer: { originOfData: 'XX' }, item: [{ lineId: '10', itemLongNumber: 'EU-T100', salesQuantity: '1' }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'FAILED');
  assert.match(body.message, /region-route/);
});

test('getPricePoints serves the quantity-break and price-list points with their source, per the ABSL contract', async () => {
  const res = await fetch(`${BASE}/rest/pricing/getPricePoints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ requestorId: 'X', originOfData: 'SAP', priceTypeCode: 'COST', supplierMainCde: '', itemLongNumber: 'EU-T100', unitCode: 'EA', currencyCode: 'EUR' }),
  });
  const body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.deepEqual(
    body.pricePoints.map((p) => [p.priceListCde, p.quantity, p.price]),
    [['SUPPLIER:ACME', '1', '90.00'], ['SUPPLIER:ACME', '50', '85.00']],
  );
  assert.equal(body.pricePoints[0].tssArticleNumber, 'EU-T100');
});

test('getConnections describes the integration endpoints read-only, PricingAdmin only', async () => {
  const res = await fetch(`${BASE}/rest/config/getConnections`, { headers: { Authorization: basicAuthHeader('bob') } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.api6.mode, 'recorded');
  assert.equal(body.api6.costSourceEndpoints.CCD, '/costs/ccd');
  assert.equal(body.api6.baseUrl, 'https://apimqua.tss.trelleborg.com'); // prefilled default
  assert.equal(body.api6.credentialsConfigured, false); // honest: no API6_USERNAME/PASSWORD in dev
  assert.equal(body.api6.biPriceListEndpoint, '/core/price/rest/v1/getPriceList');
  assert.equal(body.c4c.destinationName, 'C4C_ODATA');
  assert.equal(body.c4c.configured, false); // honest: no destination in dev
  assert.equal(body.ai.configured, false);

  const asViewer = await fetch(`${BASE}/rest/config/getConnections`, { headers: { Authorization: basicAuthHeader('alice') } });
  assert.equal(asViewer.status, 403);
});

// --- Editable connections (owner decision: WSO2/API6 endpoints are external, admins maintain them) ---

test('saveConnections versions the endpoints, and the very next pricing call routes through them', async () => {
  const save = await fetch(`${BASE}/rest/config/saveConnections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('bob') },
    body: JSON.stringify({ payload: {
      api6: { mode: 'recorded', baseUrl: null, costSourceEndpoints: { CCD: '/v2/costs/ccd-bi' }, priceListEndpoint: '/v2/costs/price-list' },
      c4c: { servicePath: '/sap/c4c/odata/v1/c4codataapi', fieldMap: {} },
    } }),
  });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.status, 'ACTIVE');
  assert.equal(saved.provenance.source, 'HUMAN'); // stamped server-side, as every config save

  // The routing walk on the next call must show the NEW endpoint path — no restart.
  const priced = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-50099', quantity: 5 }] } }),
  });
  const [line] = (await priced.json()).items;
  const ccdCall = line.trace.costRouting.calls.find((c) => c.system === 'CCD');
  assert.equal(ccdCall.endpoint, '/v2/costs/ccd-bi');
  assert.equal(line.status, 'PRICED'); // recorded mode: same cost data, only the declared route changed

  const conn = await fetch(`${BASE}/rest/config/getConnections`, { headers: { Authorization: basicAuthHeader('bob') } }).then((r) => r.json());
  assert.equal(conn.api6.costSourceEndpoints.CCD, '/v2/costs/ccd-bi');
  assert.equal(conn.api6.costSourceEndpoints.ERP, '/costs/erp'); // unset systems keep their defaults
  assert.equal(conn.configVersion, saved.version);
});

test('saveConnections refuses live mode without a base URL (422, store untouched), and never accepts credential-shaped fields', async () => {
  const noUrl = await fetch(`${BASE}/rest/config/saveConnections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('bob') },
    body: JSON.stringify({ payload: { api6: { mode: 'live', baseUrl: '' } } }),
  });
  assert.equal(noUrl.status, 422);

  const withSecret = await fetch(`${BASE}/rest/config/saveConnections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('bob') },
    body: JSON.stringify({ payload: { api6: { mode: 'recorded', apiKey: 'sk-secret' } } }),
  });
  assert.equal(withSecret.status, 422); // additionalProperties: false — a credential cannot land in config

  const asViewer = await fetch(`${BASE}/rest/config/saveConnections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { api6: { mode: 'recorded' } } }),
  });
  assert.equal(asViewer.status, 403);
});

test('fetchC4cObject answers typed C4C_CREDENTIALS_MISSING in dev and is a Viewer capability', async () => {
  const res = await fetch(`${BASE}/rest/pricing/fetchC4cObject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { objectType: 'QUOTE', objectId: 'Q-140981' } }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'C4C_CREDENTIALS_MISSING');

  const noRole = await fetch(`${BASE}/rest/pricing/fetchC4cObject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('carol') },
    body: JSON.stringify({ payload: { objectType: 'QUOTE', objectId: 'Q-1' } }),
  });
  assert.equal(noRole.status, 403);
});

test('searchC4cProducts falls back to the local recorded catalog in dev, honestly labeled', async () => {
  const res = await fetch(`${BASE}/rest/pricing/searchC4cProducts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { query: 'EU-T', region: 'EUROPE' } }),
  });
  const body = await res.json();
  assert.equal(body.status, 'OK');
  assert.equal(body.source, 'LOCAL_CATALOG'); // never pretends to be C4C
  assert.ok(body.products.some((p) => p.id === 'EU-T100'));

  const short = await fetch(`${BASE}/rest/pricing/searchC4cProducts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { query: 'E' } }),
  }).then((r) => r.json());
  assert.equal(short.source, 'NONE'); // too short to search

  const noRole = await fetch(`${BASE}/rest/pricing/searchC4cProducts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('carol') },
    body: JSON.stringify({ payload: { query: 'EU-T' } }),
  });
  assert.equal(noRole.status, 403);
});

test('fetchC4cProductDetails answers typed C4C_CREDENTIALS_MISSING in dev and is a Viewer capability', async () => {
  const res = await fetch(`${BASE}/rest/pricing/fetchC4cProductDetails`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { partNumbers: ['ORAR00125-N7H07'] } }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'C4C_CREDENTIALS_MISSING'); // typed — details are never invented

  // No parts -> empty OK without touching C4C at all.
  const empty = await fetch(`${BASE}/rest/pricing/fetchC4cProductDetails`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { partNumbers: [] } }),
  }).then((r) => r.json());
  assert.deepEqual(empty, { status: 'OK', products: {} });

  const noRole = await fetch(`${BASE}/rest/pricing/fetchC4cProductDetails`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('carol') },
    body: JSON.stringify({ payload: { partNumbers: ['X'] } }),
  });
  assert.equal(noRole.status, 403);
});

test('fetchC4cOriginOfData answers typed C4C_CREDENTIALS_MISSING in dev, empty list is a no-op, and it is a Viewer capability', async () => {
  const call = (user, payload) => fetch(`${BASE}/rest/pricing/fetchC4cOriginOfData`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(user) },
    body: JSON.stringify({ payload }),
  });
  const res = await call('alice', { items: [{ partNumber: 'ORAR00125-N7H07', ood: 'SMA', warehouse: 'LG01' }], region: 'AMERICAS' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'C4C_CREDENTIALS_MISSING'); // typed — supplier data is never invented
  assert.deepEqual(await (await call('alice', { items: [] })).json(), { status: 'OK', results: [] });
  assert.equal((await call('carol', { items: [] })).status, 403);
});

test('a cost the host already holds (hostCost, the BI contract\'s "Cost Handed Over") is the explicitly selected C4C candidate; the Additional Cost flag decides whether anything is added on top', async () => {
  const price = async (additionalCost) => (await (await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', items: [{ partNumber: 'EU-T100', quantity: 10, additionalCost, hostCost: { value: '80.00', currency: 'EUR' } }] } }),
  })).json()).items[0];

  // Flag 1: additions apply to the C4C cost: 80 + 4.7 % markup, then freight 10 % / duty 5 % / tariff 8 % of (80+3.76), + pick 20/10 = 105.02
  const one = await price('1');
  assert.equal(one.status, 'PRICED');
  assert.equal(one.result.unitPrice, '111.41');
  assert.equal(one.trace.costCandidate.source.system, 'C4C'); // beat the recorded CCD cost (100) — explicit selection wins
  assert.equal(one.trace.costCandidate.selectedBy, 'USER');
  assert.equal(one.trace.costCandidate.basis, 'MANUAL');

  // Flag 0 ("Nothing to add"): C4C's cost comes back 1:1 — no markup, no landed cost, no pick.
  const zero = await price('0');
  assert.equal(zero.result.unitPrice, '80');
});

test('price/cost unit: priceUnit 100 returns the amount per 100 pieces (rounded after scaling) and says so; absent = per piece', async () => {
  const run = async (extra) => {
    const res = await fetch(`${BASE}/rest/pricing/price`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
      body: JSON.stringify({ payload: { region: 'EUROPE', items: [{ partNumber: 'P-10023', quantity: 10, ...extra }] } }),
    });
    return (await res.json()).items[0];
  };
  const perPiece = await run({});
  assert.equal(perPiece.status, 'PRICED');
  assert.equal(perPiece.result.priceUnit, undefined);
  const per100 = await run({ priceUnit: 100 });
  assert.equal(per100.status, 'PRICED');
  assert.equal(per100.result.priceUnit, '100');
  // per piece 113.188 -> rounded 113.19; per 100 it is 11318.8 (scaled BEFORE rounding, so 0.012 per piece is not lost)
  assert.equal(per100.result.unitPrice, '11318.8');
});

// The owner's real BI/C4C line: "[AddCost 1] .0219 EUR (Unit Cost) x 1 (Qty) x 1.048 (SCM Markup) x 1.01
// (Landed Cost Factor) + 6% (Anticipated Cost Increase) + 21 EUR (Pick Charge); cost taken from Central
// Cost Database" -- C4C shows 2,102.46 EUR per 100 PC for it. Hand: (0.0219 + 0.0219*0.048 = 0.0229512)
// x 1.01 (supplier X_SIL -> warehouse 1020: freight 0.6 % + duty 0.4 %, tariff 0) = 0.02318 -> x 1.06
// = 0.0245709 -> + 21 pick / qty 1 = 21.0245709 per piece -> x 100 = 2102.457 -> 2102.46.
test('the real BI sample line (0.0219 EUR, qty 1, price unit 100) reproduces C4C\'s 2,102.46 EUR', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
    body: JSON.stringify({ payload: { region: 'EUROPE', items: [{ partNumber: 'BI-SAMPLE-0219', quantity: 1, priceUnit: 100, stockClass: 'NonMTS', supplier: 'X_SIL', warehouse: '1020' }] } }),
  });
  const l = (await res.json()).items[0];
  assert.equal(l.status, 'PRICED');
  assert.equal(l.result.unitPrice, '2102.46');
  assert.equal(l.result.priceUnit, '100');
});

test('margin: typed margin on the FIRST call gives the selling price; typed price gives the implied margin; INDIA predefined rule fires and is named; opportunity never carries them', async () => {
  const call = async (payload, user = 'alice') => {
    const res = await fetch(`${BASE}/rest/pricing/price`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(user) }, body: JSON.stringify({ payload }) });
    return (await res.json());
  };
  const base = (await call({ region: 'EUROPE', items: [{ partNumber: 'P-10023', quantity: 10 }] })).items[0].result;
  assert.equal(base.sellingPrice, undefined); // no margin typed, no rule in Europe: pure landed cost
  const withMargin = (await call({ region: 'EUROPE', items: [{ partNumber: 'P-10023', quantity: 10, margin: { marginPct: 20 } }] })).items[0].result;
  assert.equal(withMargin.unitPrice, base.unitPrice); // 113.19
  assert.equal(withMargin.sellingPrice, '141.49'); // 113.19 / 0.8 = 141.4875 -> 141.49
  assert.equal(withMargin.priceBy, 'MARGIN');
  const manual = (await call({ region: 'EUROPE', items: [{ partNumber: 'P-10023', quantity: 10, manualPrice: 155 }] })).items[0].result;
  assert.equal(manual.marginPct, '26.97'); // (155 - 113.19) / 155
  const opp = (await call({ region: 'EUROPE', hostObjectType: 'OPPORTUNITY', items: [{ partNumber: 'P-10023', quantity: 10, margin: { marginPct: 20 } }] })).items[0].result;
  assert.equal(opp.sellingPrice, undefined);
  assert.equal(opp.marginPct, undefined);
  assert.equal(opp.landedCost, '113.19');
});

test('INDIA predefined margin follows the full ABSL rule set: TSSB groups, fixed groups, 58 % default', async () => {
  const go = async (extra) => {
    const res = await fetch(`${BASE}/rest/pricing/price`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
      body: JSON.stringify({ payload: { region: 'INDIA', items: [{ partNumber: 'IN-T100', quantity: 10, supplierCountry: 'IN', ...extra }] } }) });
    return (await res.json()).items[0].result;
  };
  assert.deepEqual([await go({ supplier: 'S_BNG', productCategory: 'PH' })].map((r) => [r.marginPct, r.marginRule]), [['90', 'IN_TSSB_90']]);
  assert.equal((await go({ supplier: 'S_BNG', productCategory: 'BA' })).marginPct, '65');
  assert.equal((await go({ supplier: 'S_BNG', productCategory: 'T' })).marginPct, '60');
  assert.equal((await go({ supplier: 'OTHER', productCategory: 'PH' })).marginPct, '58'); // non-TSSB in a TSSB group
  assert.equal((await go({ supplier: 'S_BNG', productCategory: 'OA' })).marginPct, '60'); // fixed group: supplier irrelevant
  assert.equal((await go({ supplier: 'OTHER', productCategory: 'DC' })).marginPct, '55');
  assert.equal((await go({ supplier: 'OTHER', productCategory: 'YB' })).marginPct, '80');
  const dflt = await go({ supplier: 'OTHER', productCategory: 'ZZ' });
  assert.equal(dflt.marginPct, '58');
  assert.equal(dflt.marginRule, 'IN_DEFAULT_58');
  assert.equal(dflt.sellingPrice, '238.1'); // 100 / (1 - 0.58)
  assert.equal((await go({ supplier: 'S_BNG', productCategory: 'PH', margin: { marginPct: 30 } })).priceBy, 'MARGIN'); // typed always wins
});

test('CHINA predefined margin from the customer business segment: AUT 35 %, IND 65 %; no segment -> none', async () => {
  const go = async (customer) => {
    const res = await fetch(`${BASE}/rest/pricing/price`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('alice') },
      body: JSON.stringify({ payload: { region: 'CHINA', customer, items: [{ partNumber: 'CN-T100', quantity: 10, ood: 'CN' }] } }) });
    return (await res.json()).items[0].result;
  };
  assert.equal((await go({ segmentCode: 'AUT' })).marginPct, '35');
  assert.equal((await go({ segmentCode: 'IND' })).marginPct, '65');
  assert.equal((await go({})).sellingPrice, undefined);
});

test('getConnections exposes the item type sent to the gateway (default "AGN - Product"), editable via saveConnections.requestMapping', async () => {
  const auth = { Authorization: basicAuthHeader('bob'), 'Content-Type': 'application/json' };
  const before = await (await fetch(`${BASE}/rest/config/getConnections`, { headers: auth })).json();
  assert.equal(before.api6.itemTypeDesc, 'AGN - Product');
  const save = await fetch(`${BASE}/rest/config/saveConnections`, { method: 'POST', headers: auth, body: JSON.stringify({ payload: { api6: { mode: 'recorded', requestMapping: { defaultItemTypeDesc: 'AGN' } } } }) });
  assert.equal(save.status, 200);
  const after = await (await fetch(`${BASE}/rest/config/getConnections`, { headers: auth })).json();
  assert.equal(after.api6.itemTypeDesc, 'AGN');
  // restore so later tests see the default
  await fetch(`${BASE}/rest/config/saveConnections`, { method: 'POST', headers: auth, body: JSON.stringify({ payload: { api6: { mode: 'recorded', requestMapping: { defaultItemTypeDesc: 'AGN - Product' } } } }) });
});
