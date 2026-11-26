const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { hermeticEnv } = require('./hermetic-env');
const { numberKitComponents, nextItemNumber, isKitHeader, rollUp } = require('../lib/kit');

/** KIT, modeled on standard SAP SD: BOM explosion with sub-item numbering, component quantity = kit quantity x
 *  BOM quantity, pricing at header level (cost / price / margin are the roll-up of the components). */

// ---- pure rules
test('numbering: header 10 -> components 11, 12, 13 -> next ordinary item 20', () => {
  assert.deepEqual(numberKitComponents(10, 3), [11, 12, 13]);
  assert.equal(nextItemNumber([10, 11, 12, 13]), 20);
});

test('numbering: components skip numbers already used; a long BOM runs past 19 and the next item starts above it', () => {
  assert.deepEqual(numberKitComponents(10, 12, [20]), [11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23]);
  assert.equal(nextItemNumber([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23]), 30);
  assert.deepEqual(numberKitComponents(20, 3, [21, 22]), [23, 24, 25]);
  assert.deepEqual(numberKitComponents('', 2), [null, null], 'no header number = no numbering, never a guess');
});

test('a kit header is a line with components, or C4C item type ZKIT', () => {
  assert.equal(isKitHeader({ components: [{ partNumber: 'A' }] }), true);
  assert.equal(isKitHeader({ itemType: 'ZKIT' }), true);
  assert.equal(isKitHeader({ itemType: 'AGN' }), false);
  assert.equal(isKitHeader({ components: [] }), false);
});

test('rollUp: per-piece price x quantity in one kit, honoring each component\'s own price unit; margin from the sums', () => {
  const comp = (landed, selling, priceUnit) => ({ result: { unitPrice: landed, sellingPrice: selling, ...(priceUnit ? { priceUnit } : {}) } });
  const r = rollUp([{ line: comp('100', '125'), perKitQuantity: 2 }, { line: comp('5000', '6250', '100'), perKitQuantity: 1 }]);
  assert.equal(r.landed.toString(), '250'); // 100x2 + (5000/100)x1
  assert.equal(r.selling.toString(), '312.5');
  assert.equal(r.marginPct.toString(), '20');
  assert.equal(rollUp([{ line: comp('100'), perKitQuantity: 1 }]).selling, null, 'no selling price on every component -> none on the header');
});

// ---- through the API
const PORT = 4995;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
const auth = (u) => `Basic ${Buffer.from(`${u}:x`).toString('base64')}`;
before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: hermeticEnv({ PORT: String(PORT) }), stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 300)); }
  throw new Error('srv did not start');
});
after(() => child.kill('SIGKILL'));

async function call(service, action, body, user = 'alice') {
  const res = await fetch(`${BASE}/rest/${service}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth(user) }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const price = (payload, user) => call('pricing', 'price', { payload }, user);
const line = async (region, item, extra = {}) => (await price({ region, items: [item], ...extra })).body.items[0];
const D = (v) => Number(v);

test('SAP quantity rule: component quantity = kit quantity x quantity in one kit — and each component is priced at its REAL total quantity', async () => {
  const kit = await line('EUROPE', { partNumber: 'EU-KIT01', itemType: 'ZKIT', quantity: 3, ood: 'SAP' });
  assert.equal(kit.status, 'PRICED');
  assert.deepEqual(kit.trace.components.map((c) => [c.partNumber, c.result.quantity, c.perKitQuantity]), [['EU-T100', 6, 2], ['P-10023', 3, 1]]);
  // what each component costs when priced ALONE at that total quantity (quantity-dependent: pick charge is per order)
  const a = await line('EUROPE', { partNumber: 'EU-T100', quantity: 6 });
  const b = await line('EUROPE', { partNumber: 'P-10023', quantity: 3 });
  assert.equal(kit.trace.components[0].result.unitPrice, a.result.unitPrice);
  assert.equal(kit.trace.components[1].result.unitPrice, b.result.unitPrice);
  // header = per-kit roll-up: 2 x EU-T100 + 1 x P-10023
  assert.equal(D(kit.result.unitPrice).toFixed(2), (D(a.result.unitPrice) * 2 + D(b.result.unitPrice)).toFixed(2));
  assert.equal(kit.result.quantity, 3);
});

test('generic: the same kit mechanism works in every region — here CHINA via its own ERP (OOD CN), 185.76 per kit', async () => {
  const kit = await line('CHINA', { partNumber: 'CN-K001', itemType: 'ZKIT', quantity: 1, ood: 'CN' });
  assert.equal(kit.status, 'PRICED');
  assert.equal(kit.result.unitPrice, '185.76'); // pinned since topic 8
});

test('header margin: applies to every component and the header shows the same margin; selling price = roll-up', async () => {
  const kit = await line('EUROPE', { partNumber: 'EU-KIT01', itemType: 'ZKIT', quantity: 1, ood: 'SAP', margin: { marginPct: 20 } });
  assert.ok(kit.trace.components.every((c) => c.result.priceBy === 'MARGIN' && c.result.marginPct === '20'));
  assert.equal(kit.result.marginPct, '20');
  assert.equal(kit.result.priceBy, 'KIT_COMPONENTS');
  const sum = kit.trace.components.reduce((s, c) => s + D(c.result.sellingPrice) * c.perKitQuantity, 0);
  assert.equal(D(kit.result.sellingPrice).toFixed(2), sum.toFixed(2));
});

test('a component\'s own margin wins over the header margin', async () => {
  const kit = await line('CHINA', { partNumber: 'K', quantity: 1, margin: { marginPct: 20 }, components: [{ partNumber: 'CN-K001-A', quantity: 1, ood: 'CN', margin: { marginPct: 50 } }, { partNumber: 'CN-K001-B', quantity: 1, ood: 'CN' }] });
  assert.deepEqual(kit.trace.components.map((c) => c.result.marginPct), ['50', '20']);
});

test('header price unit: header amounts are per N kits, scaled from the per-kit roll-up', async () => {
  const one = await line('CHINA', { partNumber: 'CN-K001', itemType: 'ZKIT', quantity: 1, ood: 'CN' });
  const hundred = await line('CHINA', { partNumber: 'CN-K001', itemType: 'ZKIT', quantity: 1, ood: 'CN', priceUnit: 100 });
  assert.equal(hundred.result.priceUnit, '100');
  assert.equal(hundred.result.unitPrice, (D(one.result.unitPrice) * 100).toFixed(2).replace(/\.?0+$/, ''));
});

test('a typed price on the kit header is refused with a reason (it would have to be allocated across components)', async () => {
  const kit = await line('CHINA', { partNumber: 'CN-K001', itemType: 'ZKIT', quantity: 1, ood: 'CN', manualPrice: 500 });
  assert.equal(kit.status, 'MISSING');
  assert.equal(kit.missing.reason, 'KIT_HEADER_PRICE_UNSUPPORTED');
});

test('cost-only object: a kit on an OPPORTUNITY carries landed cost — header AND components — and never a price or margin', async () => {
  const r = await price({ region: 'EUROPE', hostObjectType: 'OPPORTUNITY', items: [{ partNumber: 'EU-KIT01', itemType: 'ZKIT', quantity: 1, ood: 'SAP', margin: { marginPct: 30 } }] });
  const kit = r.body.items[0];
  assert.ok(kit.result.landedCost && kit.result.sellingPrice === undefined && kit.result.marginPct === undefined);
  assert.ok(kit.trace.components.every((c) => c.result.landedCost && c.result.sellingPrice === undefined && c.result.marginPct === undefined));
});

test('typed failures, never an invented BOM: unknown kit, invalid quantity, a component that cannot be priced', async () => {
  const unknown = await line('EUROPE', { partNumber: 'NO-SUCH-KIT', itemType: 'ZKIT', quantity: 1, ood: 'SAP' });
  assert.equal(unknown.missing.reason, 'KIT_COMPONENTS_NOT_FOUND');
  assert.equal(unknown.missing.endpoint, '/core/item/rest/v1/getKitComponents'); // names the endpoint that was asked
  const badQty = await line('EUROPE', { partNumber: 'EU-KIT01', itemType: 'ZKIT', quantity: 0, ood: 'SAP' });
  assert.equal(badQty.missing.reason, 'QUANTITY_INVALID');
  const broken = await line('CHINA', { partNumber: 'K', quantity: 1, components: [{ partNumber: 'CN-K001-A', quantity: 1, ood: 'CN' }, { partNumber: 'NO-COST-ANYWHERE', quantity: 1, ood: 'CN' }] });
  assert.equal(broken.missing.reason, 'KIT_COMPONENT_UNRESOLVED');
  assert.equal(broken.missing.componentPartNumber, 'NO-COST-ANYWHERE');
});

test('a kit next to ordinary lines: results stay in request order and ordinary lines are unaffected', async () => {
  const r = await price({ region: 'EUROPE', items: [{ partNumber: 'EU-T100', quantity: 10 }, { partNumber: 'EU-KIT01', itemType: 'ZKIT', quantity: 1, ood: 'SAP' }, { partNumber: 'EU-T100', quantity: 10, supplier: 'ACME', warehouse: 'EU01' }] });
  assert.deepEqual(r.body.items.map((i) => i.partNumber), ['EU-T100', 'EU-KIT01', 'EU-T100']);
  assert.deepEqual([r.body.items[0].result.unitPrice, r.body.items[2].result.unitPrice], ['138.74', '157.07']);
});

// ---- the explode endpoint
test('fetchKitComponents: components with SAP-style item numbers, skipping numbers other lines use', async () => {
  const r = await call('pricing', 'fetchKitComponents', { payload: { region: 'EUROPE', usedItemNos: [10, 12], kits: [{ partNumber: 'EU-KIT01', ood: 'SAP', itemNo: 10 }] } });
  assert.equal(r.status, 200);
  const k = r.body.kits[0];
  assert.equal(k.status, 'OK');
  assert.deepEqual(k.components.map((c) => [c.partNumber, c.quantity, c.itemNo]), [['EU-T100', 2, 11], ['P-10023', 1, 13]]);
});

test('fetchKitComponents: the Origin of Data defaults from the region when it has exactly one; typed status otherwise; roles and bounds enforced', async () => {
  const dflt = await call('pricing', 'fetchKitComponents', { payload: { region: 'EUROPE', kits: [{ partNumber: 'EU-KIT01', itemNo: 10 }] } });
  assert.equal(dflt.body.kits[0].ood, 'SAP');
  const none = await call('pricing', 'fetchKitComponents', { payload: { kits: [{ partNumber: 'EU-KIT01' }] } });
  assert.equal(none.body.kits[0].status, 'OOD_UNKNOWN');
  assert.equal((await call('pricing', 'fetchKitComponents', { payload: { region: 'EUROPE', kits: [{ partNumber: 'EU-KIT01' }] } }, 'carol')).status, 403);
  assert.equal((await call('pricing', 'fetchKitComponents', { payload: { kits: [] } })).status, 400);
  assert.equal((await call('pricing', 'fetchKitComponents', { payload: { kits: Array.from({ length: 51 }, () => ({ partNumber: 'X', ood: 'SAP' })) } })).status, 413);
});

test('the COMMON kit endpoint and requestor id are config too (Connections), no restart', async () => {
  const saved = await call('config', 'saveConnections', { payload: { api6: { mode: 'recorded', kitEndpoint: '/core/item/rest/v2/getKitComponents', kitRequestorId: 'ZZ' }, c4c: {} } }, 'bob');
  assert.equal(saved.status, 200);
  const unknown = await line('EUROPE', { partNumber: 'NO-SUCH-KIT', itemType: 'ZKIT', quantity: 1, ood: 'SAP' });
  assert.equal(unknown.missing.endpoint, '/core/item/rest/v2/getKitComponents');
  const bad = await call('config', 'saveConnections', { payload: { api6: { mode: 'recorded', kitEndpoint: 'https://evil.example/x' }, c4c: {} } }, 'bob');
  assert.equal(bad.status, 422);
  await call('config', 'saveConnections', { payload: { api6: { mode: 'recorded' }, c4c: {} } }, 'bob'); // back to defaults for the tests below
});

test('an INDIVIDUAL endpoint for an Origin of Data is CONFIG: saving it in Connections changes which endpoint the next explosion asks, no restart', async () => {
  const saved = await call('config', 'saveConnections', { payload: { api6: { mode: 'recorded', kitEndpoints: { SAP: '/erp/sap/boms' } }, c4c: {} } }, 'bob');
  assert.equal(saved.status, 200);
  const unknown = await line('EUROPE', { partNumber: 'NO-SUCH-KIT', itemType: 'ZKIT', quantity: 1, ood: 'SAP' });
  assert.equal(unknown.missing.endpoint, '/erp/sap/boms');
  const bad = await call('config', 'saveConnections', { payload: { api6: { mode: 'recorded', kitEndpoints: { SAP: 'https://evil.example/x' } }, c4c: {} } }, 'bob');
  assert.equal(bad.status, 422, 'a kit endpoint must be an absolute PATH, never a URL');
});
