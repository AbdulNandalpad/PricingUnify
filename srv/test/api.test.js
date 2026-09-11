const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const Decimal = require('decimal.js');

const PORT = 4999;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.join(__dirname, '..', '..');
const DB_FILE = path.join(REPO_ROOT, 'db.sqlite');
let child;
let dbFileExistedBefore;

// Seeded cost-plus sell margins (srv/lib/seed.js). Every landed cost below is the number the
// kernel always produced; v2 adds unitPrice = landed / (1 - margin), HALF_UP 2dp.
const MARGIN = { EUROPE: 0.30, CHINA: 0.25, INDIA: 0.28, AMERICAS: 0.32 };
const sell = (landed, margin) => new Decimal(landed).div(new Decimal(1).minus(margin)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString();

function basicAuthHeader(user) {
  return `Basic ${Buffer.from(`${user}:x`).toString('base64')}`;
}

async function waitForHealth(timeoutMs = 30000) {
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
  dbFileExistedBefore = fs.existsSync(DB_FILE);
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // CDS_ENV=test -> the [test] profile: in-memory SQLite, never the dev db.sqlite file.
    env: { ...process.env, PORT: String(PORT), CDS_ENV: 'test' },
    stdio: 'ignore',
  });
  await waitForHealth();
});

after(() => {
  child.kill('SIGKILL');
});

async function call(method, pathname, { user, payload, query } = {}) {
  // NOT URLSearchParams: it encodes spaces as "+", and the CDS REST query parser does not
  // decode "+" back to a space (only %20) — a formula or free-text value with a space would
  // silently arrive corrupted server-side. encodeURIComponent always produces %20.
  const qs = query ? Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  const url = `${BASE}${pathname}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: basicAuthHeader(user) } : {}) },
    body: method === 'POST' ? JSON.stringify({ payload }) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}
const post = (pathname, payload, user = 'alice') => call('POST', pathname, { user, payload });
const get = (pathname, query, user = 'alice') => call('GET', pathname, { user, query });

async function priceRaw(payload, user = 'alice') {
  return post('/rest/pricing/price', payload, user);
}
async function priceRegion(region, item, extra = {}) {
  const { body } = await priceRaw({ region, salesOrg: '*', items: [item], ...extra });
  return body.items[0];
}
const priceChina = (item) => priceRegion('CHINA', item);
const callConfigAction = (action, user, payload) => post(`/rest/config/${action}`, payload, user);

// ---- on behalf of user ------------------------------------------------------------------------

test('an unauthenticated pricing request is rejected (401)', async () => {
  const res = await fetch(`${BASE}/rest/pricing/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: { region: 'EUROPE', items: [{ partNumber: 'P-10023', quantity: 1 }] } }),
  });
  assert.equal(res.status, 401);
  const who = await fetch(`${BASE}/rest/pricing/whoami`);
  assert.equal(who.status, 401);
});

test('a principal without a user behind it (client-credentials shape) is 403 NO_USER_PRINCIPAL on both services', async () => {
  // @sap/xssec is not exercisable without an XSUAA binding, so the mocked user `system`
  // (root package.json) carries exactly the shape @sap/cds builds for a client_credentials
  // token: id "system", role "system-user" — even with PricingAdmin it must be refused.
  const pricing = await call('GET', '/rest/pricing/whoami', { user: 'system' });
  assert.equal(pricing.status, 403);
  assert.equal(pricing.body.error.code, 'NO_USER_PRINCIPAL');
  const config = await call('GET', '/rest/config/getEffective', { user: 'system', query: { kind: 'region-config', key: 'EUROPE' } });
  assert.equal(config.status, 403);
  assert.equal(config.body.error.code, 'NO_USER_PRINCIPAL');
  const write = await callConfigAction('saveDraft', 'system', { kind: 'region-route', doc: { ood: 'XX', salesOrg: '*', region: 'EUROPE', version: 'x' } });
  assert.equal(write.status, 403);
  assert.equal(write.body.error.code, 'NO_USER_PRINCIPAL');
});

test('PRICING_REQUIRE_USER_PRINCIPAL=false lifts the check (opt-in, reversible) — everything else about auth is unchanged', async () => {
  const port = PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const relaxed = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), CDS_ENV: 'test', PRICING_REQUIRE_USER_PRINCIPAL: 'false' },
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    // Still requires SOME valid token — no credential at all is still 401.
    const noAuth = await fetch(`${base}/rest/pricing/whoami`);
    assert.equal(noAuth.status, 401);
    // The client-credentials-shaped mocked user now goes through instead of 403.
    const system = await fetch(`${base}/rest/pricing/whoami`, { headers: { Authorization: basicAuthHeader('system') } });
    assert.equal(system.status, 200);
    assert.equal((await system.json()).id, 'system');
    // A real named user is completely unaffected either way.
    const bob = await fetch(`${base}/rest/pricing/whoami`, { headers: { Authorization: basicAuthHeader('bob') } });
    assert.equal(bob.status, 200);
  } finally {
    relaxed.kill('SIGKILL');
  }
});

test('whoami returns the token identity and roles', async () => {
  const alice = await get('/rest/pricing/whoami');
  assert.deepEqual(alice.body, { id: 'alice', roles: ['PricingViewer'] });
  const bob = await get('/rest/pricing/whoami', undefined, 'bob');
  assert.equal(bob.body.id, 'bob');
  assert.ok(bob.body.roles.includes('PricingAdmin'));
});

test('the test profile uses the in-memory database — db.sqlite is never created by the suite', () => {
  if (!dbFileExistedBefore) assert.equal(fs.existsSync(DB_FILE), false);
});

// ---- cost plus (every landed cost unchanged, sell price on top) ------------------------------------

test('an authenticated pricing request prices against the seeded EUROPE config and stores a document', async () => {
  const { status, body } = await priceRaw({ region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'P-10023', quantity: 10 }] });
  assert.equal(status, 200);
  const [line] = body.items;
  assert.equal(line.status, 'PRICED');
  assert.equal(line.technique, 'COST_PLUS');
  assert.equal(line.routedBy, 'DEFAULT');
  // Topic 4 (Appendix A): P-10023 is MTS, so freight+duty don't apply -- BASE(100) +
  // SCM_MARKUP(4.7) + PICK_CHARGE(21/10=2.1) = 106.8 landed; sell = 106.8 / 0.7.
  assert.equal(line.result.landedCost, '106.8');
  assert.equal(line.result.unitPrice, sell('106.8', MARGIN.EUROPE));
  assert.equal(line.result.unitPrice, '152.57');
  assert.equal(line.result.margin, '0.3');
  assert.equal(line.trace.stockClass, 'MTS'); // P-10023's recorded raw code "MTS" resolves via EUROPE's stockClassMap
  assert.equal(line.trace.sell.source, 'REGION_DEFAULT');
  assert.equal(body.config.version, '2026.08.0');
  assert.equal(body.config.books.EU_SEALS.version, '2026.09.1');
  assert.equal(body.config.routing.version, '2026.09.1');
  assert.equal(body.requestedBy, 'alice');
  assert.match(body.documentId, /^[0-9a-f-]{36}$/);
});

test('a line margin override replaces the region default (cost plus only)', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'P-10023', quantity: 10, marginOverride: 0.25 });
  assert.equal(line.result.landedCost, '106.8');
  assert.equal(line.result.unitPrice, '142.4');
  assert.equal(line.trace.sell.source, 'LINE_OVERRIDE');
});

test('a raw ERP stock-class code normalizes to NonMTS via the region stockClassMap', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'P-30078', quantity: 4 });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.trace.stockClass, 'NonMTS'); // P-30078's recorded raw code is "OMT"
});

test('EUROPE Non-MTS cost resolves via CCD (PIR data) first, per the stock-class-aware access sequence', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'P-30078', quantity: 4 });
  assert.equal(line.trace.costCandidate.source.system, 'CCD');
  assert.equal(line.trace.costCandidate.selectedBy, 'ACCESS_SEQUENCE:CCD');
});

test('fetchItemAttributes resolves stock class and product attributes up front -- supplier/warehouse stay user input until C4C is wired', async () => {
  const { status, body } = await post('/rest/pricing/fetchItemAttributes', { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'EU-T100' }, { partNumber: 'P-10023' }, { partNumber: 'PTFE-BRG-137' }] });
  assert.equal(status, 200);
  assert.deepEqual(body.attributes['EU-T100'], {
    supplier: null, supplierCountry: null, warehouse: null, stockClass: 'NonMTS', stockClassError: null, product: { family: 'Hydraulic seals' },
  });
  assert.equal(body.attributes['P-10023'].stockClass, 'MTS');
  assert.deepEqual(body.attributes['PTFE-BRG-137'].product, { family: 'PTFE bearings', spec: '137', variant: 'custom', diameter_mm: 137 });
});

test('fetchItemAttributes never prices -- a caller-supplied supplier passes through and resolves its country from supplier master data', async () => {
  const { body } = await post('/rest/pricing/fetchItemAttributes', { region: 'EUROPE', salesOrg: '*', items: [{ partNumber: 'EU-T100', supplier: 'GLOBEX' }] });
  assert.equal(body.attributes['EU-T100'].supplier, 'GLOBEX');
  assert.equal(body.attributes['EU-T100'].supplierCountry, 'NL');
});

test('a part whose raw stock-class code is not in the region stockClassMap comes back MISSING, not silently priced', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'P-90400', quantity: 1 });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'STOCK_CLASS_UNRESOLVED');
  assert.equal(line.missing.detail, 'STOCK_CLASS_UNMAPPED:ZZZ');
  assert.equal(line.flags[0].level, 'crit');
});

test('topic 7: a supplier quantity-break part (P-90600) picks its COST tier by the real order quantity and stays inside cost plus', async () => {
  const below = await priceRegion('EUROPE', { partNumber: 'P-90600', quantity: 5 });
  assert.equal(below.technique, 'COST_PLUS');
  assert.equal(below.trace.costCandidate.selectedBy, 'DEFAULT');
  assert.equal(below.trace.costCandidate.value, '18.49');
  const mid = await priceRegion('EUROPE', { partNumber: 'P-90600', quantity: 30 });
  assert.equal(mid.trace.costCandidate.selectedBy, 'USER');
  assert.equal(mid.trace.costCandidate.value, '15.41');
  const high = await priceRegion('EUROPE', { partNumber: 'P-90600', quantity: 200 });
  assert.equal(high.trace.costCandidate.value, '10.70');
});

test('a business user typing a hypothetical MROQ for an OOD=SMA part switches to the matching quantity-break cost', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'P-90500', quantity: 60, ood: 'SMA', mroqOverride: 60 });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.result.landedCost, '13.79');
  assert.equal(line.result.unitPrice, sell('13.79', MARGIN.EUROPE));
  assert.equal(line.trace.costCandidate.selectedBy, 'USER');
  assert.equal(line.trace.costCandidate.value, '12.84');
});

test('an MROQ override is ignored for a non-SMA OOD, but the automatic quantity-break lookup still applies', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'P-90500', quantity: 60, mroqOverride: 60 });
  assert.equal(line.trace.costCandidate.value, '12.84');
  assert.equal(line.trace.costCandidate.source.key, 'QTY_BREAK_P-90500_50');
});

test('China route 1: OOD is JDE China -- the cost is already landed, only the 3.2% LCS markup applies', async () => {
  const line = await priceChina({ partNumber: 'CN-P001', quantity: 1, ood: 'CN' });
  assert.equal(line.result.landedCost, '103.2');
  assert.equal(line.result.unitPrice, sell('103.2', MARGIN.CHINA));
});

test('China route 2: direct from a non-LCE supplier -- freight&duty x1.32 (US) / x1.21 (non-US), then 3.2% markup', async () => {
  const us = await priceChina({ partNumber: 'CN-P002', quantity: 1, ood: 'SAP', supplier: 'TSS_LIVORNO', supplierCountry: 'US' });
  assert.equal(us.result.landedCost, '136.22');
  assert.equal(us.result.unitPrice, sell('136.22', MARGIN.CHINA));
  const it = await priceChina({ partNumber: 'CN-P003', quantity: 1, ood: 'SAP', supplier: 'TSS_LIVORNO', supplierCountry: 'IT' });
  assert.equal(it.result.landedCost, '124.87');
});

test('China route 3: via LCE/SAP Europe -- freight&duty, 3.2% markup, then a further 6% LCE markup', async () => {
  const us = await priceChina({ partNumber: 'CN-P004', quantity: 1, ood: 'SAP', supplier: '88058', supplierCountry: 'US' });
  assert.equal(us.result.landedCost, '144.4');
  assert.equal(us.trace.constraintPasses.length, 0); // no supplier-config for 88058 -- branching is `when`-driven only
  const it = await priceChina({ partNumber: 'CN-P005', quantity: 1, ood: 'SAP', supplier: '88058', supplierCountry: 'IT' });
  assert.equal(it.result.landedCost, '132.36');
});

test('China MOLV (topic 5): below-MOLV orders bump the QUANTITY on the landed cost, never the price', async () => {
  const below = await priceChina({ partNumber: 'CN-P006', quantity: 1, ood: 'CN' });
  assert.equal(below.result.landedCost, '103.2');
  assert.equal(below.result.quantity, 5); // ceil(500 / 103.2)
  assert.equal(below.trace.constraintPasses[0].mode, 'QUANTITY');
  assert.ok(below.flags.some((f) => f.code === 'MOLV_APPLIED'));
  const atMolv = await priceChina({ partNumber: 'CN-P006', quantity: 5, ood: 'CN' });
  assert.equal(atMolv.result.quantity, 5);
  assert.equal(atMolv.trace.constraintPasses.length, 0);
});

test('topic 8: a kit header prices as the sum of its components\' sell prices, each through its own full build-up', async () => {
  const line = await priceChina({ partNumber: 'CN-K001', quantity: 3, components: [{ partNumber: 'CN-K001-A', quantity: 2, ood: 'CN' }, { partNumber: 'CN-K001-B', quantity: 1, ood: 'CN' }] });
  assert.equal(line.status, 'PRICED');
  assert.equal(line.technique, 'COST_PLUS');
  // A: 50 * 1.032 = 51.6 landed -> 68.8 sell, x2. B: 80 * 1.032 = 82.56 -> 110.08, x1.
  assert.equal(line.trace.components[0].result.landedCost, '51.6');
  assert.equal(line.trace.components[0].result.unitPrice, sell('51.6', MARGIN.CHINA));
  assert.equal(line.trace.components[1].result.unitPrice, sell('82.56', MARGIN.CHINA));
  assert.equal(line.result.unitPrice, new Decimal(sell('51.6', MARGIN.CHINA)).times(2).plus(sell('82.56', MARGIN.CHINA)).toString()); // 247.68
  assert.equal(line.result.landedCost, '185.76');
  assert.equal(line.result.quantity, 3);
  assert.equal(line.trace.kit, true);
});

test('topic 8: a kit with an unresolvable component comes back MISSING, not silently priced off the good components', async () => {
  const line = await priceChina({ partNumber: 'CN-K002', quantity: 1, components: [{ partNumber: 'CN-K001-A', quantity: 1, ood: 'CN' }, { partNumber: 'CN-K002-BAD', quantity: 1, ood: 'CN' }] });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'KIT_COMPONENT_UNRESOLVED');
  assert.equal(line.missing.componentPartNumber, 'CN-K002-BAD');
});

test('topic 8 (v2): a component routed to a non-cost-plus technique makes the kit KIT_COMPONENT_UNRESOLVED', async () => {
  const line = await priceChina({ partNumber: 'CN-K003', quantity: 1, components: [{ partNumber: 'CN-K001-A', quantity: 1, ood: 'CN' }, { partNumber: 'OR-25X3-NBR', quantity: 10, pricingType: 'PRICE_LIST', book: 'EU_SEALS' }] });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'KIT_COMPONENT_UNRESOLVED');
  assert.equal(line.missing.componentPartNumber, 'OR-25X3-NBR');
  assert.equal(line.missing.componentIssue.reason, 'KIT_COMPONENT_NOT_COST_PLUS');
});

test('topic 8: a kit requested for a region without a real BOM-explosion path (Europe) is a typed MISSING', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'EU-KIT', quantity: 1, components: [{ partNumber: 'P-10023', quantity: 1 }] });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'KIT_NOT_SUPPORTED_FOR_REGION');
});

test('topic 10: the Additional Cost flag (0-4) picks which elements apply, independent of stock class', async () => {
  // P-90700: NonMTS, base 100, freight 10%, duty 5%, tariff 8% (rates on base+markup=104.7), pick 20 (qty 1).
  const landedFor = async (additionalCost) => (await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, ...(additionalCost === undefined ? {} : { additionalCost }) })).result.landedCost;
  assert.equal(await landedFor(0), '100'); // "0 - Nothing to add"
  assert.equal(await landedFor(1), '148.78'); // "1 - Landed cost & Markup"
  assert.equal(await landedFor(undefined), '148.78'); // never setting the flag prices identically to option 1 for a NonMTS part
  assert.equal(await landedFor(2), '104.7'); // "2 - Markup only"
  assert.equal(await landedFor(3), '113.08'); // "3 - No Landed cost and Pick"
  assert.equal(await landedFor(4), '140.41'); // "4 - Landed cost & Markup, No tariff"
  const opt0 = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 0 });
  assert.equal(opt0.result.unitPrice, sell('100', MARGIN.EUROPE)); // the sell margin still applies on top of whatever landed
});

test('topic 10: additionalCost never forces freight/duty onto an MTS part', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'P-10023', quantity: 10, additionalCost: 1 });
  assert.equal(line.result.landedCost, '106.8');
});

test('topic 10: an unrecognized additionalCost value is a typed MISSING, not a guess', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'P-90700', quantity: 1, additionalCost: 9 });
  assert.equal(line.status, 'MISSING');
  assert.equal(line.missing.reason, 'ADDITIONAL_COST_UNRESOLVED');
  assert.equal(line.missing.detail, 'ADDITIONAL_COST_UNMAPPED:9');
});

test('India: local supplier = raw cost; overseas (or unresolved) supplier = +40%', async () => {
  const local = await priceRegion('INDIA', { partNumber: 'IN-P001', quantity: 1, supplierCountry: 'IN' });
  assert.equal(local.result.landedCost, '50');
  assert.equal(local.result.unitPrice, sell('50', MARGIN.INDIA));
  const overseas = await priceRegion('INDIA', { partNumber: 'IN-P002', quantity: 1, supplierCountry: 'DE' });
  assert.equal(overseas.result.landedCost, '70');
  const unknown = await priceRegion('INDIA', { partNumber: 'IN-P002', quantity: 1 });
  assert.equal(unknown.result.landedCost, '70', 'an unresolved supplier country falls in the overseas branch');
});

test('Americas: LCA Handling Fee tiers by supplier country, freight/duty/tariff only on Non-MTS', async () => {
  const cases = [
    [{ partNumber: 'US-P001', quantity: 10, supplierCountry: 'US' }, '110.1'], // MTS, US: 100 + 6.7 + 34/10
    [{ partNumber: 'US-P002', quantity: 10, supplierCountry: 'US' }, '128.24'], // NonMTS, US: + 106.7*(0.10+0.05+0.02)
    [{ partNumber: 'US-P003', quantity: 10, supplierCountry: 'CN' }, '113.9'], // MTS, overseas: 10.5% LCA
    [{ partNumber: 'US-P004', quantity: 10, supplierCountry: 'CN' }, '132.69'], // NonMTS, overseas
    [{ partNumber: 'US-P001', quantity: 10, supplier: 'US-ACME' }, '110.1'], // supplierCountry resolved from supplier-config
  ];
  for (const [item, landed] of cases) {
    const line = await priceRegion('AMERICAS', item);
    assert.equal(line.status, 'PRICED');
    assert.equal(line.result.landedCost, landed);
    assert.equal(line.result.unitPrice, sell(landed, MARGIN.AMERICAS));
  }
});

test('Americas: effective-dated LCA Handling Fee -- the 6.2%->6.7% (Jan 2026) rate change reprices historical dates correctly', async () => {
  const { body } = await priceRaw({ region: 'AMERICAS', salesOrg: '*', priceDate: '2025-08-01', items: [{ partNumber: 'US-P001', quantity: 10, supplierCountry: 'US' }] });
  assert.equal(body.items[0].result.landedCost, '109.6');
  assert.equal(body.config.version, '2025.06.0');
  assert.equal(body.config.books.EU_SEALS, undefined, 'a price list valid from 2026-09-01 is not in force in 2025');
  const after = await priceRegion('AMERICAS', { partNumber: 'US-P001', quantity: 10, supplierCountry: 'US' });
  assert.equal(after.result.landedCost, '110.1');
});

test('supplier overrides: per-warehouse freight/duty/tariff and supplier-wide MOLV, applied over the generic API6 elements', async () => {
  const generic = await priceRegion('EUROPE', { partNumber: 'P-70200', quantity: 10 });
  assert.equal(generic.result.landedCost, '172.03'); // 157.05 + 157.05*(0.06+0.022+0) + 21/10
  const acmeEu = await priceRegion('EUROPE', { partNumber: 'P-70200', quantity: 30, supplier: 'ACME', warehouse: 'EU01' });
  assert.equal(acmeEu.result.landedCost, '219.78');
  assert.equal(acmeEu.trace.constraintPasses.length, 0);
  const acmeNoWarehouse = await priceRegion('EUROPE', { partNumber: 'P-70200', quantity: 30, supplier: 'ACME' });
  assert.equal(acmeNoWarehouse.result.landedCost, '170.63');
  const acmeUs = await priceRegion('EUROPE', { partNumber: 'P-70200', quantity: 30, supplier: 'ACME', warehouse: 'US01' });
  assert.equal(acmeUs.result.landedCost, '251.98');
});

test('a below-MOQ, below-MOLV order surfaces both constraints -- MOLV from the supplier, MOQ from the part\'s own facts', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'P-70200', quantity: 1, supplier: 'ACME' });
  assert.equal(line.result.landedCost, '300'); // ACME's MOLV floor lifts the 1-unit line
  assert.equal(line.result.unitPrice, sell('300', MARGIN.EUROPE));
  const kinds = line.trace.constraintPasses.map((c) => c.kind);
  assert.ok(kinds.includes('FLOOR'));
  assert.ok(kinds.includes('MIN_QTY'));
  assert.ok(line.flags.some((f) => f.code === 'BELOW_MOQ'));
});

test('an unknown region/salesOrg with no effective config is a clear 422, not a crash', async () => {
  const { status } = await priceRaw({ region: 'ANTARCTICA', items: [{ partNumber: 'P-1', quantity: 1 }] });
  assert.equal(status, 422);
});

// Verification parts: one per region, all with a STATIC 100.00 base cost and round charge
// values, so every factor the config applies is directly readable in the result.
test('EU-T100: 100 + 4.7% markup + 10%/5%/8% freight/duty/tariff on 104.7 + 20/10 pick = 130.78 EUR landed; 186.83 sell', async () => {
  const line = await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10 });
  assert.equal(line.trace.costCandidate.value, '100.00');
  assert.equal(line.trace.stockClass, 'NonMTS');
  assert.equal(line.result.landedCost, '130.78');
  assert.equal(line.result.unitPrice, '186.83');
});

test('CN-T100: JDE China route = 103.2 CNY landed; SAP route (US supplier) = 136.22', async () => {
  const jde = await priceChina({ partNumber: 'CN-T100', quantity: 1, ood: 'CN' });
  assert.equal(jde.result.landedCost, '103.2');
  assert.equal(jde.result.unitPrice, sell('103.2', MARGIN.CHINA));
  const sap = await priceChina({ partNumber: 'CN-T100', quantity: 1, ood: 'SAP', supplier: 'TSS_LIVORNO', supplierCountry: 'US' });
  assert.equal(sap.result.landedCost, '136.22');
});

test('IN-T100: local supplier = 100 INR landed; overseas = 140 INR (+40%)', async () => {
  const local = await priceRegion('INDIA', { partNumber: 'IN-T100', quantity: 1, supplierCountry: 'IN' });
  assert.equal(local.result.landedCost, '100');
  assert.equal(local.result.unitPrice, sell('100', MARGIN.INDIA));
  const overseas = await priceRegion('INDIA', { partNumber: 'IN-T100', quantity: 1 });
  assert.equal(overseas.result.landedCost, '140');
});

test('US-T100: US supplier = 134.64 USD landed; overseas = 139.32 USD', async () => {
  const domestic = await priceRegion('AMERICAS', { partNumber: 'US-T100', quantity: 10, supplierCountry: 'US' });
  assert.equal(domestic.trace.stockClass, 'NonMTS');
  assert.equal(domestic.result.landedCost, '134.64');
  assert.equal(domestic.result.unitPrice, sell('134.64', MARGIN.AMERICAS));
  const overseas = await priceRegion('AMERICAS', { partNumber: 'US-T100', quantity: 10 });
  assert.equal(overseas.result.landedCost, '139.32');
});

test('same part, same warehouse, three suppliers -- three landed costs, driven by the supplier\'s per-warehouse terms', async () => {
  assert.equal((await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10, supplier: 'ACME', warehouse: 'EU01' })).result.landedCost, '148.06');
  assert.equal((await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10, supplier: 'GLOBEX', warehouse: 'EU01' })).result.landedCost, '124.5');
  assert.equal((await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10, supplier: 'INITECH', warehouse: 'EU01' })).result.landedCost, '146.49');
  assert.equal((await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10, supplier: 'ACME', warehouse: 'US01' })).result.landedCost, '169.52');
  assert.equal((await priceRegion('EUROPE', { partNumber: 'EU-T100', quantity: 10, supplier: 'ACME' })).result.landedCost, '130.78');
});

// ---- price list and catalog through the API --------------------------------------------------------

test('price list: an O-Ring routes to EU_SEALS by family; the customer row beats the tier row, discount applies', async () => {
  const { body } = await priceRaw({ region: 'EUROPE', customerId: 'CUST-DE-001', priceDate: '2026-09-10', items: [{ partNumber: 'OR-25X3-NBR', quantity: 500 }] });
  const [line] = body.items;
  assert.equal(line.status, 'PRICED');
  assert.equal(line.technique, 'PRICE_LIST');
  assert.equal(line.book, 'EU_SEALS');
  assert.equal(line.routedBy, 'RULE:0');
  assert.equal(line.result.unitPrice, '0.92'); // 0.95 * 0.97
  assert.equal(line.result.landedCost, null);
  assert.equal(body.party.tier, 'A'); // enriched from party-config, never from the payload
  assert.ok(line.flags.some((f) => f.code === 'ROW_EXPIRES'));
});

test('price list: a tier-B customer gets the default row and the quantity tier; MOLV raises a small order', async () => {
  const big = (await priceRaw({ region: 'EUROPE', customerId: 'CUST-DE-007', priceDate: '2026-09-10', items: [{ partNumber: 'OR-25X3-NBR', quantity: 600 }] })).body.items[0];
  assert.equal(big.result.unitPrice, '1.1');
  const small = (await priceRaw({ region: 'EUROPE', customerId: 'CUST-DE-007', priceDate: '2026-09-10', items: [{ partNumber: 'OR-25X3-NBR', quantity: 10 }] })).body.items[0];
  assert.equal(small.result.unitPrice, '10'); // 1.20 * 10 = 12 < MOLV 100 -> 100 / 10
  assert.ok(small.flags.some((f) => f.code === 'MOLV_APPLIED'));
});

test('price list: the book is scoped to EUROPE -- the same O-Ring in CHINA falls back to cost plus and is MISSING without a cost', async () => {
  const line = (await priceRaw({ region: 'CHINA', customerId: 'CUST-CN-003', priceDate: '2026-09-10', items: [{ partNumber: 'OR-25X3-NBR', quantity: 500 }] })).body.items[0];
  assert.equal(line.technique, 'COST_PLUS');
  assert.equal(line.routedBy, 'DEFAULT');
  assert.equal(line.status, 'MISSING');
});

test('catalog: an exact spec match is a sell price (margin skipped); a custom size is priced by the formula with margin, discount and floor check', async () => {
  const { body } = await priceRaw({ region: 'EUROPE', customerId: 'CUST-DE-001', priceDate: '2026-09-10', items: [{ partNumber: 'PTFE-BRG-120', quantity: 4 }, { partNumber: 'PTFE-BRG-137', quantity: 2 }] });
  const [catalog, formula] = body.items;
  assert.equal(catalog.technique, 'CATALOG_FORMULA');
  assert.equal(catalog.book, 'PTFE_BEARINGS');
  assert.equal(catalog.trace.source, 'CATALOG');
  assert.equal(catalog.result.unitPrice, '82.32'); // 84 * 0.98
  assert.equal(catalog.result.landedCost, null);
  assert.equal(formula.trace.source, 'FORMULA');
  assert.equal(formula.result.landedCost, '174.94'); // 137 * 0.62 + 180 / 2
  assert.equal(formula.result.unitPrice, '202.3'); // * 1.18 * 0.98
  assert.equal(formula.trace.costInputs['cost.machining_setup'].value, '180');
  assert.ok(formula.flags.some((f) => f.code === 'PRICED_BY_FORMULA'));
});

test('routing: a user can force the technique per line (routedBy USER)', async () => {
  const line = (await priceRaw({ region: 'EUROPE', customerId: 'CUST-DE-001', items: [{ partNumber: 'PTFE-BRG-120', quantity: 4, pricingType: 'COST_PLUS' }] })).body.items[0];
  assert.equal(line.technique, 'COST_PLUS');
  assert.equal(line.routedBy, 'USER');
  assert.equal(line.status, 'MISSING'); // the catalog part has no ERP cost in the recorded facts -- typed, not zero
});

// ---- pricing documents ----------------------------------------------------------------------------

test('every price call stores a PricingDocument: documentId round-trips through getPricingDocument with request, result and trace', async () => {
  const payload = { region: 'EUROPE', customerId: 'CUST-DE-001', priceDate: '2026-09-10', hostObjectType: 'QUOTE', hostObjectId: 'Q-ROUNDTRIP-1', items: [{ partNumber: 'EU-T100', quantity: 10 }] };
  const priced = await priceRaw(payload);
  const { status, body } = await get('/rest/pricing/getPricingDocument', { id: priced.body.documentId });
  assert.equal(status, 200);
  assert.equal(body.ID, priced.body.documentId);
  assert.equal(body.requestedBy, 'alice');
  assert.equal(body.hostObjectId, 'Q-ROUNDTRIP-1');
  assert.equal(body.region, 'EUROPE');
  assert.equal(body.priceDate, '2026-09-10');
  assert.equal(body.configVersions.version, '2026.08.0');
  assert.deepEqual(body.request, payload);
  assert.equal(body.result.items[0].result.unitPrice, '186.83');
  assert.ok(Array.isArray(body.result.items[0].trace.steps));

  const listed = await get('/rest/pricing/listPricingDocuments', { hostObjectId: 'Q-ROUNDTRIP-1' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.documents.length, 1);
  assert.equal(listed.body.documents[0].ID, priced.body.documentId);
  assert.equal(listed.body.documents[0].request, undefined, 'the listing is a summary, not the payloads');

  const missing = await get('/rest/pricing/getPricingDocument', { id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(missing.status, 404);
});

// ---- config reads -----------------------------------------------------------------------------------

test('getEffective accepts every key spelling callers use for a composite key', async () => {
  for (const key of ['EUROPE', 'EUROPE::*', 'EUROPE/*', 'EUROPE:*']) {
    const { status, body } = await get('/rest/config/getEffective', { kind: 'region-config', key });
    assert.equal(status, 200, key);
    assert.equal(body.region, 'EUROPE');
    assert.equal(body.version, '2026.08.0');
    assert.equal(body.sell.defaultMargin, 0.3);
  }
  const routing = await get('/rest/config/getEffective', { kind: 'routing-rules', key: '*' });
  assert.equal(routing.body.rules.length, 3); // O-Rings, PTFE bearings, back-up rings
  const unknownKind = await get('/rest/config/getEffective', { kind: 'widgets', key: 'x' });
  assert.equal(unknownKind.status, 400);
  const none = await get('/rest/config/getEffective', { kind: 'price-list', key: 'NOPE' });
  assert.equal(none.status, 404);
});

test('listBooks summarises price lists and catalogs; listVersions/getVersion read any kind', async () => {
  const lists = await get('/rest/config/listBooks', { kind: 'price-list' });
  assert.equal(lists.body.books[0].id, 'EU_SEALS');
  assert.equal(lists.body.books[0].rows, 11); // 4 original + 7 real O-Ring rows (2026-09-11 data pass)
  const catalogs = await get('/rest/config/listBooks', { kind: 'catalog-book' });
  assert.equal(catalogs.body.books.length, 2); // PTFE_BEARINGS + BACKUP_RINGS_PTFE
  const ptfe = catalogs.body.books.find((b) => b.id === 'PTFE_BEARINGS');
  assert.deepEqual(ptfe.costInputs, ['ptfe_rate_per_mm', 'machining_setup']);
  const backupRings = catalogs.body.books.find((b) => b.id === 'BACKUP_RINGS_PTFE');
  assert.deepEqual(backupRings.costInputs, ['ptfe_rate_per_mm_cs', 'machining_setup']);
  assert.equal(backupRings.rows, 2);
  const versions = await get('/rest/config/listVersions', { kind: 'catalog-book', key: 'PTFE_BEARINGS' });
  assert.equal(versions.body.versions.length, 1);
  const version = await get('/rest/config/getVersion', { kind: 'catalog-book', key: 'PTFE_BEARINGS', version: '2026.09.1' });
  assert.equal(version.body.fallbackFormula, 'diameter_mm * cost.ptfe_rate_per_mm + cost.machining_setup / quantity');
});

test('validateFormula checks syntax and, against a book, that every cost.* exists in its costInputs', async () => {
  const ok = await get('/rest/config/validateFormula', { formula: 'diameter_mm * cost.ptfe_rate_per_mm', kind: 'catalog-book', key: 'PTFE_BEARINGS' });
  assert.equal(ok.body.ok, true);
  assert.deepEqual(ok.body.unknown, []);
  const unknown = await get('/rest/config/validateFormula', { formula: 'diameter_mm * cost.nope', kind: 'catalog-book', key: 'PTFE_BEARINGS' });
  assert.equal(unknown.body.ok, false);
  assert.deepEqual(unknown.body.unknown, ['cost.nope']);
  const broken = await get('/rest/config/validateFormula', { formula: 'diameter_mm * (' });
  assert.equal(broken.body.ok, false);
  assert.ok(broken.body.error);
});

test('getEffectiveConfig (legacy alias) is readable by any authenticated user', async () => {
  const { status, body } = await get('/rest/config/getEffectiveConfig', { region: 'EUROPE', salesOrg: '*' });
  assert.equal(status, 200);
  assert.equal(body.region, 'EUROPE');
  assert.equal(body.version, '2026.08.0');
});

test('getEffectiveRegionRoute and getEffectivePartyConfig (legacy aliases) still answer, and party-config now carries tier', async () => {
  const route = await get('/rest/config/getEffectiveRegionRoute', { ood: 'SAP', salesOrg: '*' });
  assert.equal(route.body.region, 'EUROPE');
  assert.equal(route.body.entityLabel, 'TSS Germany');
  const party = await get('/rest/config/getEffectivePartyConfig', { customerId: 'CUST-DE-001' });
  assert.equal(party.body.customerOod, 'SAP');
  assert.equal(party.body.tier, 'A');
});

test('listSuppliers returns every supplier globally, independent of region', async () => {
  const { suppliers } = (await get('/rest/config/listSuppliers')).body;
  const ids = suppliers.map((s) => s.supplier);
  for (const expected of ['ACME', 'GLOBEX', 'INITECH', 'US-ACME']) assert.ok(ids.includes(expected), `missing ${expected}`);
  assert.equal(suppliers.find((s) => s.supplier === 'INITECH').warehouses.EU01.tariff, '0.2');
});

// ---- region derivation (C4C payload review) ------------------------------------------------------------

test('C4C payload review: omitting region derives it from customerOod via region-route (explicit region still wins)', async () => {
  const { status, body } = await priceRaw({ salesOrg: '*', customerOod: 'SAP', items: [{ partNumber: 'P-10023', quantity: 10 }] });
  assert.equal(status, 200);
  assert.deepEqual(body.region, { value: 'EUROPE', derivedBy: 'ROUTE:SAP', entityLabel: 'TSS Germany' });
  const explicit = await priceRaw({ region: 'EUROPE', salesOrg: '*', customerOod: 'CN', items: [{ partNumber: 'P-10023', quantity: 10 }] });
  assert.equal(explicit.body.region.derivedBy, 'EXPLICIT');
});

test('C4C payload review: region derives from customerId via party-config; an explicit customerOod overrides the stored one', async () => {
  const viaParty = await priceRaw({ salesOrg: '*', customerId: 'CUST-US-002', items: [{ partNumber: 'US-P001', quantity: 5 }] });
  assert.equal(viaParty.body.region.value, 'AMERICAS');
  assert.equal(viaParty.body.region.derivedBy, 'ROUTE:SMA');
  const overridden = await priceRaw({ salesOrg: '*', customerId: 'CUST-US-002', customerOod: 'SAP', items: [{ partNumber: 'P-10023', quantity: 5 }] });
  assert.equal(overridden.body.region.value, 'EUROPE');
});

test('the MCP client\'s neutral payload shape (context/party) is accepted alongside the flat fields', async () => {
  const { status, body } = await priceRaw({ context: { hostSystem: 'MCP', hostObjectType: 'OPPORTUNITY', purpose: 'INDICATIVE' }, party: { customerId: 'CUST-DE-001', salesOrg: '*' }, priceDate: '2026-09-10', items: [{ partNumber: 'OR-25X3-NBR', quantity: 500 }] });
  assert.equal(status, 200);
  assert.equal(body.region.derivedBy, 'ROUTE:SAP');
  assert.equal(body.items[0].result.unitPrice, '0.92');
  const doc = await get('/rest/pricing/getPricingDocument', { id: body.documentId });
  assert.equal(doc.body.hostSystem, 'MCP');
  assert.equal(doc.body.hostObjectType, 'OPPORTUNITY');
});

test('C4C payload review: no region, no customer, or no route match are typed 400s, never a silent guess', async () => {
  assert.equal((await priceRaw({ salesOrg: '*', items: [{ partNumber: 'P-10023', quantity: 1 }] })).status, 400);
  assert.equal((await priceRaw({ salesOrg: '*', customerOod: 'ZZZ', items: [{ partNumber: 'P-10023', quantity: 1 }] })).status, 400);
  assert.equal((await priceRaw({ region: 'EUROPE', items: [] })).status, 400);
});

// ---- config writes: roles, drafts, publish, discard, diff, simulate -------------------------------------

test('every config write is PricingAdmin-only (403 for a PricingViewer)', async () => {
  const writes = [
    ['saveDraft', { kind: 'region-route', doc: { ood: 'ZZ', salesOrg: '*', region: 'EUROPE', version: 'x' } }],
    ['publish', { kind: 'region-route', key: 'ZZ::*', version: 'x' }],
    ['discardDraft', { kind: 'region-route', key: 'ZZ::*', version: 'x' }],
    ['saveActive', { kind: 'region-route', doc: { ood: 'ZZ', salesOrg: '*', region: 'EUROPE', version: 'x' } }],
    ['suggestChange', { targetKind: 'region-config', targetKey: 'EUROPE', instruction: 'add tariff' }],
    ['approveSuggestion', { suggestionId: 'x', newVersion: 'y' }],
    ['rejectSuggestion', { suggestionId: 'x' }],
    ['saveRegionConfig', { region: 'EUROPE', salesOrg: 'DE99', version: 'x' }],
    ['saveSupplierConfig', { supplier: 'X', version: 'x' }],
    ['saveRegionRoute', { ood: 'ZZ', salesOrg: '*', region: 'EUROPE', version: 'x' }],
    ['savePartyConfig', { customerId: 'CUST-X', version: 'x' }],
  ];
  for (const [action, payload] of writes) {
    const { status } = await callConfigAction(action, 'alice', payload);
    assert.equal(status, 403, action);
  }
});

test('saveDraft -> the draft is NOT used for pricing -> publish -> it is; provenance and publishedBy are the token\'s user', async () => {
  const effective = (await get('/rest/config/getEffective', { kind: 'region-config', key: 'EUROPE' })).body;
  const { version, status: _s, supersedes, provenance, ...content } = effective;
  const draftDoc = { ...content, salesOrg: 'DE50', sell: { defaultMargin: 0.5 }, provenance: { source: 'AI_SUGGESTED', authoredBy: 'forged', authoredAt: '2020-01-01T00:00:00Z' } };

  const saved = await callConfigAction('saveDraft', 'bob', { kind: 'region-config', doc: draftDoc });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.status, 'DRAFT');
  assert.match(saved.body.version, /^\d{4}-\d{2}-\d{2}-r\d+$/, 'version auto-assigned YYYY-MM-DD-rN');
  assert.equal(saved.body.provenance.source, 'HUMAN', 'payload provenance is ignored');
  assert.equal(saved.body.provenance.authoredBy, 'bob');
  assert.equal(saved.body.provenance.publishedBy, undefined);

  const drafts = await get('/rest/config/listDrafts', { kind: 'region-config' });
  assert.ok(drafts.body.drafts.some((d) => d.key === 'EUROPE::DE50' && d.version === saved.body.version));

  // A DRAFT never prices: DE50 still falls back to the region-wide "*" default.
  const beforePublish = await priceRaw({ region: 'EUROPE', salesOrg: 'DE50', items: [{ partNumber: 'P-10023', quantity: 10 }] });
  assert.equal(beforePublish.body.config.salesOrg, '*');
  assert.equal(beforePublish.body.items[0].result.unitPrice, '152.57');

  const asViewer = await callConfigAction('publish', 'alice', { kind: 'region-config', key: 'EUROPE/DE50', version: saved.body.version });
  assert.equal(asViewer.status, 403);

  const published = await callConfigAction('publish', 'bob', { kind: 'region-config', key: 'EUROPE/DE50', version: saved.body.version, effectiveFrom: '2026-08-01', note: 'DE50 gets a 50% margin' });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.status, 'ACTIVE');
  assert.equal(published.body.provenance.publishedBy, 'bob');
  assert.equal(published.body.provenance.note, 'DE50 gets a 50% margin');
  assert.ok(published.body.provenance.publishedAt);

  const afterPublish = await priceRaw({ region: 'EUROPE', salesOrg: 'DE50', items: [{ partNumber: 'P-10023', quantity: 10 }] });
  assert.equal(afterPublish.body.config.salesOrg, 'DE50');
  assert.equal(afterPublish.body.config.version, saved.body.version);
  assert.equal(afterPublish.body.items[0].result.landedCost, '106.8');
  assert.equal(afterPublish.body.items[0].result.unitPrice, '213.6'); // 106.8 / 0.5

  const republish = await callConfigAction('publish', 'bob', { kind: 'region-config', key: 'EUROPE/DE50', version: saved.body.version });
  assert.equal(republish.status, 422, 'only a DRAFT can be published');
});

test('publishing a second draft supersedes the ACTIVE version and closes its window', async () => {
  const base = (await get('/rest/config/getEffective', { kind: 'region-config', key: 'EUROPE/DE50' })).body;
  const { version: baseVersion, status: _s, supersedes, provenance, ...content } = base;
  const saved = await callConfigAction('saveDraft', 'bob', { kind: 'region-config', doc: { ...content, version: 'DE50-v2', sell: { defaultMargin: 0.4 } } });
  assert.equal(saved.status, 200);
  const published = await callConfigAction('publish', 'bob', { kind: 'region-config', key: 'EUROPE::DE50', version: 'DE50-v2', effectiveFrom: '2026-09-01' });
  assert.equal(published.status, 200);
  assert.equal(published.body.supersedes, baseVersion);
  const versions = (await get('/rest/config/listVersions', { kind: 'region-config', key: 'EUROPE::DE50' })).body.versions;
  const old = versions.find((v) => v.version === baseVersion);
  assert.equal(old.status, 'SUPERSEDED');
  assert.equal(old.validTo, '2026-09-01');
  const asOfAugust = await priceRaw({ region: 'EUROPE', salesOrg: 'DE50', priceDate: '2026-08-15', items: [{ partNumber: 'P-10023', quantity: 10 }] });
  assert.equal(asOfAugust.body.items[0].result.unitPrice, '213.6', 'historical dates reprice against the version live then');
  const now = await priceRaw({ region: 'EUROPE', salesOrg: 'DE50', priceDate: '2026-09-10', items: [{ partNumber: 'P-10023', quantity: 10 }] });
  assert.equal(now.body.items[0].result.unitPrice, '178'); // 106.8 / 0.6
});

test('discardDraft rejects the draft; it can no longer be published and never priced', async () => {
  const saved = await callConfigAction('saveDraft', 'bob', { kind: 'region-route', doc: { ood: 'ZZ', salesOrg: '*', region: 'EUROPE', entityLabel: 'Discard me', version: 'zz-1' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.status, 'DRAFT');
  const discarded = await callConfigAction('discardDraft', 'bob', { kind: 'region-route', key: 'ZZ', version: 'zz-1' });
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.status, 'REJECTED');
  const version = await get('/rest/config/getVersion', { kind: 'region-route', key: 'ZZ::*', version: 'zz-1' });
  assert.equal(version.body.status, 'REJECTED');
  const publish = await callConfigAction('publish', 'bob', { kind: 'region-route', key: 'ZZ', version: 'zz-1' });
  assert.equal(publish.status, 422);
  const again = await callConfigAction('discardDraft', 'bob', { kind: 'region-route', key: 'ZZ', version: 'zz-1' });
  assert.equal(again.status, 422);
  const priced = await priceRaw({ salesOrg: '*', customerOod: 'ZZ', items: [{ partNumber: 'P-10023', quantity: 1 }] });
  assert.equal(priced.status, 400, 'a discarded route never resolves a region');
});

test('saveDraft validates against the kind\'s non-negotiables (422) and the store stays untouched', async () => {
  const before = (await get('/rest/config/listVersions', { kind: 'price-list', key: 'BAD_LIST' })).body.versions.length;
  const bad = await callConfigAction('saveDraft', 'bob', {
    kind: 'price-list',
    doc: { id: 'BAD_LIST', name: 'bad', currency: 'EUR', dimensions: [], rows: [{ part: 'X', match: { tier: 'A' }, tiers: [{ from: 10, value: '1' }] }] },
  });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error.message, /undeclared dimension/);
  assert.match(bad.body.error.message, /start at quantity 0/);
  const after = (await get('/rest/config/listVersions', { kind: 'price-list', key: 'BAD_LIST' })).body.versions.length;
  assert.equal(after, before);
});

test('publishing routing rules that point at a book with no ACTIVE version is refused (cross-document check)', async () => {
  const saved = await callConfigAction('saveDraft', 'bob', { kind: 'routing-rules', doc: { version: 'routing-bad', rules: [{ when: { family: 'Gaskets' }, type: 'PRICE_LIST', book: 'NO_SUCH_BOOK' }] } });
  assert.equal(saved.status, 200, 'a DRAFT may reference a book that does not exist yet');
  const publish = await callConfigAction('publish', 'bob', { kind: 'routing-rules', key: '*', version: 'routing-bad' });
  assert.equal(publish.status, 422);
  assert.match(publish.body.error.message, /NO_SUCH_BOOK/);
  const live = await get('/rest/config/getEffective', { kind: 'routing-rules', key: '*' });
  assert.equal(live.body.version, '2026.09.1', 'the live rules are untouched');
});

test('price list draft: diff shows exactly the changed cell; simulate prices LIVE vs DRAFT with deltas; publish goes live', async () => {
  const live = (await get('/rest/config/getEffective', { kind: 'price-list', key: 'EU_SEALS' })).body;
  const { version, status: _s, supersedes, provenance, ...content } = live;
  const rows = content.rows.map((r) => ({ ...r }));
  const customerRow = rows.findIndex((r) => r.match && r.match.customer === 'CUST-DE-001');
  rows[customerRow] = { ...rows[customerRow], tiers: [{ from: 0, value: '0.90' }] };
  const saved = await callConfigAction('saveDraft', 'bob', { kind: 'price-list', doc: { ...content, rows } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const draftVersion = saved.body.version;

  const diff = await get('/rest/config/diff', { kind: 'price-list', key: 'EU_SEALS', a: '2026.09.1', b: draftVersion });
  assert.equal(diff.status, 200);
  assert.deepEqual(diff.body.changes, [{ path: `/rows/${customerRow}/tiers/0/value`, from: '0.95', to: '0.90' }]);

  const priced = await priceRaw({ region: 'EUROPE', customerId: 'CUST-DE-001', priceDate: '2026-09-10', hostObjectId: 'Q-SIM-1', items: [{ partNumber: 'OR-25X3-NBR', quantity: 500 }] });
  const sim = await post('/rest/pricing/simulate', {
    draft: { kind: 'price-list', key: 'EU_SEALS', version: draftVersion },
    region: 'EUROPE', customerId: 'CUST-DE-001', priceDate: '2026-09-10',
    items: [{ partNumber: 'OR-25X3-NBR', quantity: 500 }, { partNumber: 'EU-T100', quantity: 10 }],
    documentIds: [priced.body.documentId],
  });
  assert.equal(sim.status, 200, JSON.stringify(sim.body));
  assert.equal(sim.body.draft.version, draftVersion);
  assert.equal(sim.body.items.length, 3);
  const [orLine, euLine, docLine] = sim.body.items;
  assert.equal(orLine.before.unitPrice, '0.92');
  assert.equal(orLine.after.unitPrice, '0.87'); // 0.90 * 0.97 = 0.873
  assert.equal(orLine.delta, '-0.05');
  assert.equal(orLine.changed, true);
  assert.equal(euLine.before.unitPrice, euLine.after.unitPrice, 'a cost-plus line is unaffected by a price list draft');
  assert.equal(euLine.changed, false);
  assert.equal(docLine.source, priced.body.documentId);
  assert.equal(docLine.after.unitPrice, '0.87');
  assert.equal(sim.body.summary.changed, 2);
  assert.ok(sim.body.deadRows.some((r) => r.part === 'OR-40X5-FKM'), 'rows nothing hit are reported as dead');

  const stillLive = await priceRaw({ region: 'EUROPE', customerId: 'CUST-DE-001', priceDate: '2026-09-10', items: [{ partNumber: 'OR-25X3-NBR', quantity: 500 }] });
  assert.equal(stillLive.body.items[0].result.unitPrice, '0.92', 'simulate publishes nothing');

  const published = await callConfigAction('publish', 'bob', { kind: 'price-list', key: 'EU_SEALS', version: draftVersion, effectiveFrom: '2026-09-05' });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const now = await priceRaw({ region: 'EUROPE', customerId: 'CUST-DE-001', priceDate: '2026-09-10', items: [{ partNumber: 'OR-25X3-NBR', quantity: 500 }] });
  assert.equal(now.body.items[0].result.unitPrice, '0.87');
  assert.equal(now.body.config.books.EU_SEALS.version, draftVersion);
  const past = await priceRaw({ region: 'EUROPE', customerId: 'CUST-DE-001', priceDate: '2026-09-03', items: [{ partNumber: 'OR-25X3-NBR', quantity: 500 }] });
  assert.equal(past.body.items[0].result.unitPrice, '0.92', 'the superseded version still prices its own window');
});

test('simulate: a catalog draft that lowers the margin reports the floor crossing', async () => {
  const live = (await get('/rest/config/getEffective', { kind: 'catalog-book', key: 'PTFE_BEARINGS' })).body;
  const { version, status: _s, supersedes, provenance, ...content } = live;
  const saved = await callConfigAction('saveDraft', 'bob', { kind: 'catalog-book', doc: { ...content, margin: [{ match: {}, value: '0.10' }], discount: [{ match: {}, value: '0.05' }] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const sim = await post('/rest/pricing/simulate', {
    draft: { kind: 'catalog-book', key: 'PTFE_BEARINGS', version: saved.body.version },
    region: 'EUROPE', customerId: 'CUST-DE-007', priceDate: '2026-09-10',
    items: [{ partNumber: 'PTFE-BRG-137', quantity: 2 }],
  });
  assert.equal(sim.status, 200);
  assert.equal(sim.body.floorCrossings.length, 1);
  assert.equal(sim.body.floorCrossings[0].direction, 'BELOW_FLOOR');
  assert.ok(sim.body.items[0].flagsAdded.includes('MARGIN_FLOOR'));
  const bad = await post('/rest/pricing/simulate', { draft: { kind: 'catalog-book', key: 'PTFE_BEARINGS', version: 'nope' }, items: [{ partNumber: 'X', quantity: 1 }] });
  assert.equal(bad.status, 404);
});

test('the AI-suggestion endpoint targets any kind, reports AI_NOT_CONFIGURED without a key, and approval is admin-only', async () => {
  const viewer = await callConfigAction('suggestChange', 'alice', { targetKind: 'price-list', targetKey: 'EU_SEALS', instruction: 'raise tier A discount to 5%' });
  assert.equal(viewer.status, 403);
  const admin = await callConfigAction('suggestChange', 'bob', { targetKind: 'price-list', targetKey: 'EU_SEALS', instruction: 'raise tier A discount to 5%' });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.status, 'AI_NOT_CONFIGURED');
  const legacy = await callConfigAction('suggestChange', 'bob', { region: 'EUROPE', instruction: 'add tariff' });
  assert.equal(legacy.body.status, 'AI_NOT_CONFIGURED');
  const unknown = await callConfigAction('approveSuggestion', 'bob', { suggestionId: 'does-not-exist', newVersion: '2026.08.1' });
  assert.equal(unknown.status, 404);
  const list = await get('/rest/config/listSuggestions', { status: 'PENDING_REVIEW' });
  assert.deepEqual(list.body.suggestions, []);
});

// ---- legacy direct saves (saveActive semantics) ----------------------------------------------------------

test('a PricingAdmin can save a brand-new ACTIVE region-config version (legacy alias), and pricing picks it up immediately', async () => {
  const doc = {
    region: 'EUROPE',
    salesOrg: 'DE99',
    version: 'DE99-2026.08.0',
    validFrom: '2026-08-01',
    resolution: [{ id: 'RES_TEST', costBasis: 'STANDARD' }],
    buildUp: [{ id: 'BASE_COST', type: 'BASE' }, { id: 'FLAT_MARKUP', type: 'FACTOR', basis: ['BASE_COST'], rate: 0.10 }],
  };
  const { status, body } = await callConfigAction('saveRegionConfig', 'bob', doc);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.status, 'ACTIVE');
  assert.equal(body.provenance.source, 'HUMAN');
  assert.equal(body.provenance.authoredBy, 'bob');
  assert.equal(body.provenance.publishedBy, 'bob');
  const priced = await priceRaw({ region: 'EUROPE', salesOrg: 'DE99', items: [{ partNumber: 'P-10023', quantity: 1 }] });
  assert.equal(priced.body.items[0].result.landedCost, '110');
  assert.equal(priced.body.items[0].result.unitPrice, '110', 'a region without a sell section prices unitPrice = landedCost');
  assert.equal(priced.body.items[0].result.margin, null);
});

test('saveRegionConfig rejects an invalid document (FACTOR with no basis) with a 422 and never touches the store', async () => {
  const before = (await get('/rest/config/listVersions', { region: 'EUROPE', salesOrg: 'DE98' })).body.versions.length;
  assert.equal(before, 0);
  const { status } = await callConfigAction('saveRegionConfig', 'bob', { region: 'EUROPE', salesOrg: 'DE98', version: 'bad-1', buildUp: [{ id: 'BASE_COST', type: 'BASE' }, { id: 'BAD_FACTOR', type: 'FACTOR' }] });
  assert.equal(status, 422);
  assert.equal((await get('/rest/config/listVersions', { region: 'EUROPE', salesOrg: 'DE98' })).body.versions.length, 0);
});

test('saveActive and the legacy direct saves create ACTIVE supplier-config, region-route and party-config documents', async () => {
  const supplier = await callConfigAction('saveSupplierConfig', 'bob', { supplier: 'DIRECTEDIT', version: 'v1', validFrom: '2026-08-01', warehouses: { EU01: { freight: '7.50' } } });
  assert.equal(supplier.status, 200);
  assert.equal(supplier.body.warehouses.EU01.freight, '7.50');
  const route = await callConfigAction('saveActive', 'bob', { kind: 'region-route', doc: { ood: 'ZY', salesOrg: '*', region: 'EUROPE', entityLabel: 'Test Entity', version: 'v1', validFrom: '2026-08-01' } });
  assert.equal(route.status, 200, JSON.stringify(route.body));
  assert.equal(route.body.status, 'ACTIVE');
  const party = await callConfigAction('savePartyConfig', 'bob', { customerId: 'CUST-DIRECT-EDIT', version: 'v1', validFrom: '2026-08-01', territory: 'TEST', customerOod: 'SAP', tier: 'B' });
  assert.equal(party.status, 200);
  assert.equal(party.body.tier, 'B');
  const missingVersion = await callConfigAction('saveActive', 'bob', { kind: 'region-route', doc: { ood: 'ZX', salesOrg: '*', region: 'EUROPE' } });
  assert.equal(missingVersion.status, 400);
});
