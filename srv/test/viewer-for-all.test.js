const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { hermeticEnv } = require('./hermetic-env');

/** Access model: every authenticated user is a Viewer (no role assignment for ~1200 users); PricingAdmin is an explicit grant. */
async function boot(port, extra) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: hermeticEnv({ PORT: String(port), ...extra }), stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { try { if ((await fetch(`${base}/health`)).ok) return { child, base }; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 300)); }
  child.kill('SIGKILL');
  throw new Error('srv did not start');
}
const auth = (u) => `Basic ${Buffer.from(`${u}:x`).toString('base64')}`;
const post = (s, svc, action, user, body) => fetch(`${s.base}/rest/${svc}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: auth(user) } : {}) }, body: JSON.stringify(body) });

let open; let strict;
before(async () => { open = await boot(4981, {}); strict = await boot(4982, { TSS_VIEWER_FOR_ALL: 'false' }); });
after(() => { open.child.kill('SIGKILL'); strict.child.kill('SIGKILL'); });

const priceBody = { payload: { region: 'EUROPE', items: [{ partNumber: 'EU-T100', quantity: 10 }] } };

test('default: a user with NO role (carol) can price, and `me` says Viewer yes / Admin no', async () => {
  const r = await post(open, 'pricing', 'price', 'carol', priceBody);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).items[0].status, 'PRICED');
  const me = await (await fetch(`${open.base}/rest/pricing/me`, { headers: { Authorization: auth('carol') } })).json();
  assert.deepEqual(me.roles, { PricingViewer: true, PricingAdmin: false });
});

test('default: Admin is still an explicit grant — config endpoints stay 403 for everyone without PricingAdmin; anonymous is 401', async () => {
  const exp = (user) => fetch(`${open.base}/rest/config/exportConfig`, { headers: { Authorization: auth(user) } });
  assert.equal((await exp('carol')).status, 403);
  assert.equal((await exp('alice')).status, 403);
  assert.equal((await exp('bob')).status, 200);
  assert.equal((await post(open, 'pricing', 'price', null, priceBody)).status, 401);
});

test('TSS_VIEWER_FOR_ALL=false: the PricingViewer role is required again (carol 403, alice 200)', async () => {
  assert.equal((await post(strict, 'pricing', 'price', 'carol', priceBody)).status, 403);
  assert.equal((await post(strict, 'pricing', 'price', 'alice', priceBody)).status, 200);
  const me = await (await fetch(`${strict.base}/rest/pricing/me`, { headers: { Authorization: auth('carol') } })).json();
  assert.deepEqual(me.roles, { PricingViewer: false, PricingAdmin: false });
});
