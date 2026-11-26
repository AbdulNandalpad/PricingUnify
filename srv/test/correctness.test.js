const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { hermeticEnv } = require('./hermetic-env');

/** Regression tests for the correctness bugs found in the 2026-11-26 review — each case is the
 *  exact request that misbehaved, run against a real server, with the value it must now give. */

const PORT = 4996;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
const auth = (u) => `Basic ${Buffer.from(`${u}:x`).toString('base64')}`;

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: hermeticEnv({ PORT: String(PORT) }), stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('srv did not start');
});
after(() => child.kill('SIGKILL'));

async function call(service, action, body, user = 'alice') {
  const res = await fetch(`${BASE}/rest/${service}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth(user) }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const price = (payload, user) => call('pricing', 'price', { payload }, user);
const prices = async (items, extra = {}) => (await price({ region: 'EUROPE', items, ...extra })).body.items.map((i) => (i.result ? i.result.unitPrice : i.missing && i.missing.reason));

// ---- C1: the same part on several lines
test('C1: the same part with different suppliers prices each line on ITS OWN supplier terms', async () => {
  assert.deepEqual(await prices([
    { partNumber: 'EU-T100', quantity: 10, supplier: 'ACME', warehouse: 'EU01' },
    { partNumber: 'EU-T100', quantity: 10, supplier: 'GLOBEX', warehouse: 'EU01' },
  ]), ['157.07', '132.07']); // standalone: ACME 157.07, GLOBEX 132.07 (both used to answer 132.07)
});

test('C1: a supplier line does not leak its terms onto a plain line of the same part, in either order', async () => {
  assert.deepEqual(await prices([{ partNumber: 'EU-T100', quantity: 10, supplier: 'ACME', warehouse: 'EU01' }, { partNumber: 'EU-T100', quantity: 10 }]), ['157.07', '138.74']);
  assert.deepEqual(await prices([{ partNumber: 'EU-T100', quantity: 10 }, { partNumber: 'EU-T100', quantity: 10, supplier: 'ACME', warehouse: 'EU01' }]), ['138.74', '157.07']);
});

test('C1: lines of one part with different host costs (price-break shape) each use their own cost', async () => {
  const line = (id, cost) => ({ lineId: id, itemLongNumber: 'EU-T100', salesQuantity: 10, c4cUnitCostAmt: cost, costCurrencyCode: 'EUR', useCostPlusFlag: '0', stockClassGroupCode: 'OMT' });
  const r = await call('pricing', 'getCustomerPriceList', { requestorId: 'X', customer: { customerId: '1', originOfData: 'SAP', custcurrency: 'EUR' }, item: [line('1', 80), line('2', 50)] });
  assert.deepEqual(r.body.calculatedPriceList.map((l) => [l.lineId, l.costPlusUnitAmt]), [['1', '80'], ['2', '50']]);
});

test('C1: fetchItemAttributes answers one entry per requested line (a repeated part does not collapse)', async () => {
  const r = await call('pricing', 'fetchItemAttributes', { payload: { region: 'EUROPE', items: [{ partNumber: 'EU-T100', quantity: 1, supplier: 'ACME' }, { partNumber: 'EU-T100', quantity: 1, supplier: 'GLOBEX' }] } });
  assert.deepEqual(r.body.lines.map((l) => [l.partNumber, l.supplier]), [['EU-T100', 'ACME'], ['EU-T100', 'GLOBEX']]);
});

// ---- H1: quantity
test('H1: a bad quantity is MISSING(QUANTITY_INVALID) for that line, never a 500 or a negative price', async () => {
  for (const quantity of ['abc', null, -5, 0]) {
    const r = await price({ region: 'EUROPE', items: [{ partNumber: 'EU-T100', quantity }, { partNumber: 'EU-T100', quantity: 10 }] });
    assert.equal(r.status, 200, String(quantity));
    assert.deepEqual(r.body.items.map((i) => i.status), ['MISSING', 'PRICED']);
    assert.equal(r.body.items[0].missing.reason, 'QUANTITY_INVALID');
  }
  const none = await price({ region: 'EUROPE', items: [{ partNumber: 'EU-T100' }] });
  assert.equal(none.status, 200);
  assert.equal(none.body.items[0].missing.reason, 'QUANTITY_INVALID');
});

test('H1: the facade no longer invents a quantity of 1 for a missing salesQuantity', async () => {
  const r = await call('pricing', 'getCustomerPriceList', { requestorId: 'X', customer: { customerId: '1', originOfData: 'SAP', custcurrency: 'EUR' }, item: [{ lineId: '1', itemLongNumber: 'EU-T100', stockClassGroupCode: 'OMT' }] });
  assert.equal(r.body.status, 'SUCCESS');
  assert.equal(r.body.calculatedPriceList[0].costPlusUnitAmt, '0'); // MISSING -> "0" + reason, the ABSL's "cost not available" path
});

// ---- M2 / M3
test('M2: purpose, hostObjectType and priceDate are validated — a typo never falls back to the permissive default', async () => {
  const items = [{ partNumber: 'P-40012', quantity: 1 }];
  for (const [field, value] of [['purpose', 'binding'], ['hostObjectType', 'opportunity'], ['priceDate', 'zzz'], ['priceDate', '2026-02-31']]) {
    const r = await price({ region: 'EUROPE', items, [field]: value });
    assert.equal(r.status, 400, `${field}=${value}`);
    assert.ok(r.body.error.message.includes(field), r.body.error.message);
  }
  const binding = await price({ region: 'EUROPE', purpose: 'BINDING', items });
  assert.equal(binding.body.items[0].status, 'BLOCKED'); // the exact value still blocks the FALLBACK cost
});

test('M3: an explicit selectedCostId that matches nothing is typed MISSING, not a USER-selected other cost', async () => {
  const r = await price({ region: 'EUROPE', items: [{ partNumber: 'EU-T100', quantity: 1, selectedCostId: 'NOPE' }] });
  assert.equal(r.body.items[0].status, 'MISSING');
  assert.equal(r.body.items[0].missing.reason, 'SELECTED_COST_NOT_FOUND');
});

// ---- M1: kits
const kit = (components, quantity = 1) => price({ region: 'CHINA', items: [{ partNumber: 'KIT', quantity, components }] }).then((r) => r.body.items[0]);

test('M1: the pinned demo kit is unchanged (185.76 CNY)', async () => {
  const k = await kit([{ partNumber: 'CN-K001-A', quantity: 2, ood: 'CN' }, { partNumber: 'CN-K001-B', quantity: 1, ood: 'CN' }]);
  assert.equal(k.result.unitPrice, '185.76');
  assert.equal(k.trace.region, 'CHINA');
  assert.ok(k.trace.configVersion);
});

test('M1: a component whose order rule RAISED its quantity does not inflate the kit (needs 1, not the raised 5)', async () => {
  const k = await kit([{ partNumber: 'CN-P006', quantity: 1, ood: 'CN' }]);
  assert.equal(k.trace.components[0].result.quantity, 5); // the component line itself was raised by its MOLV rule…
  assert.equal(k.result.unitPrice, '103.2');              // …but the kit contains ONE of it at 103.2
});

test('M1: a component priced per 100 pieces contributes its per-PIECE price x quantity', async () => {
  const k = await kit([{ partNumber: 'CN-K001-A', quantity: 2, ood: 'CN', priceUnit: 100 }]);
  assert.equal(k.result.unitPrice, '103.2'); // 5160 per 100 -> 51.6 each x 2 (it used to be 10320)
});

test('M1: a kit in a region without kit support is MISSING and its components are not priced', async () => {
  const r = await price({ region: 'EUROPE', items: [{ partNumber: 'K', quantity: 1, components: [{ partNumber: 'EU-T100', quantity: 1 }] }] });
  assert.equal(r.body.items[0].missing.reason, 'KIT_NOT_SUPPORTED_FOR_REGION');
  assert.deepEqual(r.body.items[0].trace.components, []);
});

// ---- M9: facade failures
// The facade's catch-all (a thrown error -> {status:'FAILED'}) wraps the whole handler; the failures that can be
// provoked over HTTP are request-level ones, and those must also stay FAILED with HTTP 200 for the ABSL.
test('M9: facade request-level failures answer {status:FAILED} with HTTP 200 (what the ABSL parses), never a 500', async () => {
  const unroutable = await call('pricing', 'getCustomerPriceList', { requestorId: 'X', customer: { originOfData: 'NOPE' }, item: [{ lineId: '1', itemLongNumber: 'X', salesQuantity: 1 }] });
  assert.equal(unroutable.status, 200);
  assert.equal(unroutable.body.status, 'FAILED');
  const noOrigin = await call('pricing', 'getPricePoints', { originOfData: '', itemLongNumber: '' });
  assert.equal(noOrigin.status, 200);
  assert.equal(noOrigin.body.status, 'FAILED');
});

// ---- H2 / H3 / M6 through the config API
async function getConfig(region = 'EUROPE') {
  const res = await fetch(`${BASE}/rest/config/getEffectiveConfig(region='${region}',salesOrg='*')`, { headers: { Authorization: auth('bob') } });
  return res.json();
}

test('H2: a config with an unparsable `when` is refused with 422 and the region keeps pricing', async () => {
  const cfg = await getConfig('INDIA');
  cfg.version = 'bad-when-1';
  cfg.buildUp = [...cfg.buildUp, { id: 'ZZ', type: 'ADDER', amount: '1', when: 'this is not valid' }];
  const r = await call('config', 'saveRegionConfig', { payload: cfg }, 'bob');
  assert.equal(r.status, 422);
  const ok = await price({ region: 'INDIA', items: [{ partNumber: 'IN-T100', quantity: 1, supplierCountry: 'IN' }] });
  assert.equal(ok.status, 200);
});

test('H3: a caller-supplied status DRAFT is ignored — a direct save is always ACTIVE and takes effect', async () => {
  const cfg = await getConfig('INDIA');
  cfg.version = 'status-ignored-1'; cfg.status = 'DRAFT';
  const r = await call('config', 'saveRegionConfig', { payload: cfg }, 'bob');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ACTIVE');
});
