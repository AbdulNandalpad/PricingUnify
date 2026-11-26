const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { hermeticEnv } = require('./hermetic-env');

/** Config is code (no database): files under config/ are applied on boot, PROD is read-only, QUA edits can be exported. */

async function boot(port, extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: hermeticEnv({ PORT: String(port), ...extraEnv }), stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { try { if ((await fetch(`${base}/health`)).ok) return { child, base }; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 300)); }
  child.kill('SIGKILL');
  throw new Error('srv did not start');
}
const auth = (u) => `Basic ${Buffer.from(`${u}:x`).toString('base64')}`;
const api = (base) => async (service, action, body, user = 'bob') => {
  const res = await fetch(`${base}/rest/${service}/${action}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth(user) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-config-'));
const supplier = {
  supplier: 'REAL-SUP', supplierCountry: 'DE', version: '2026-11-26-r1', status: 'ACTIVE', supersedes: null, validFrom: '2026-11-26', validTo: null,
  warehouses: { 1020: { freight: '0.02', duty: '0.01', tariff: '0' } },
  provenance: { source: 'HUMAN', authoredBy: 'owner', authoredAt: '2026-11-26T00:00:00Z' },
};
fs.writeFileSync(path.join(dir, 'supplier-config.json'), JSON.stringify([supplier]));

let prod; let qua;
before(async () => {
  prod = await boot(4991, { TSS_ENVIRONMENT: 'PROD', TSS_CONFIG_DIR: dir });
  qua = await boot(4992, {});
});
after(() => { prod.child.kill('SIGKILL'); qua.child.kill('SIGKILL'); });

test('PROD: config is read-only — every write is refused with a message that says how to change it', async () => {
  const call = api(prod.base);
  for (const [action, payload] of [['saveRegionConfig', { region: 'EUROPE', salesOrg: '*', version: 'x' }], ['saveSupplierConfig', { supplier: 'S', version: 'x' }], ['saveConnections', { api6: {}, c4c: {} }], ['approveSuggestion', { id: 'x' }]]) {
    const r = await call('config', action, { payload });
    assert.equal(r.status, 409, action);
    assert.match(r.body.error.message, /read-only in PROD/);
  }
  const me = await call('pricing', 'me');
  assert.equal(me.body.configEditable, false);
  assert.equal((await call('config', 'getConnections')).body.configEditable, false);
});

test('PROD: no demo suppliers are seeded; the supplier from config/supplier-config.json is there and prices through its terms', async () => {
  const call = api(prod.base);
  const list = (await call('config', 'listSuppliers')).body;
  const ids = (list.suppliers || list.value || []).map((s) => s.supplier || s);
  assert.ok(ids.includes('REAL-SUP'), JSON.stringify(list));
  assert.ok(!ids.includes('ACME') && !ids.includes('X_SIL'), 'demo suppliers must not exist in PROD');
  const one = await fetch(`${prod.base}/rest/config/getEffectiveSupplierConfig(supplier='REAL-SUP')`, { headers: { Authorization: auth('bob') } });
  assert.equal(one.status, 200);
  assert.equal((await one.json()).warehouses['1020'].freight, '0.02');
});

test('QUA: editing is allowed and demo data is seeded; exportConfig returns every version so it can be committed under config/', async () => {
  const call = api(qua.base);
  assert.equal((await call('pricing', 'me')).body.configEditable, true);
  const exp = (await call('config', 'exportConfig')).body;
  assert.equal(exp.environment, 'QUA');
  assert.ok(exp.documents['region-config'].length >= 4);
  assert.ok(exp.documents['supplier-config'].some((s) => s.supplier === 'ACME'));
  assert.ok(exp.documents['region-route'].length >= 4);
  // an exported document is accepted as-is by the loader (round trip)
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-roundtrip-'));
  for (const [kind, docs] of Object.entries(exp.documents)) fs.writeFileSync(path.join(out, `${kind}.json`), JSON.stringify(docs));
  require('../lib/seed').seed(); // this process's own store, seeded exactly like the QUA server
  const { loadConfigFiles } = require('../lib/config-files');
  const r = loadConfigFiles(out);
  assert.ok(r.files.includes('region-config.json'));
  assert.equal(r.applied, 0, 'everything exported already exists in this store -> nothing re-applied');
  assert.ok(r.skipped > 0);
});

test('a refused document stops the load with the file and the reason; a missing folder is fine', () => {
  const { loadConfigFiles } = require('../lib/config-files');
  assert.deepEqual(loadConfigFiles(path.join(dir, 'nope')), { applied: 0, skipped: 0, files: [] });
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-bad-'));
  fs.writeFileSync(path.join(bad, 'supplier-config.json'), JSON.stringify([{ ...supplier, version: 'bad', moq: 5 }]));
  assert.throws(() => loadConfigFiles(bad), /supplier-config\.json document #1 .*refused/);
  fs.writeFileSync(path.join(bad, 'supplier-config.json'), '{not json');
  assert.throws(() => loadConfigFiles(bad), /not valid JSON/);
});
