const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** Every operation of both services declares who may call it — an operation added without @requires would be open to
 *  every signed-in user (and, since all of them are Viewers, to ~1200 people). Config operations must be PricingAdmin. */
function operations(file) {
  const lines = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n');
  const out = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s*(function|action)\s+(\w+)/);
    if (!m) return;
    let j = i - 1;
    while (j >= 0 && (lines[j].trim() === '' || lines[j].trim().startsWith('//'))) j -= 1;
    const req = (lines[j].match(/@requires:\s*'([^']+)'/) || [])[1] || null;
    out.push({ name: m[2], requires: req });
  });
  return out;
}

test('every operation declares @requires', () => {
  for (const file of ['config-service.cds', 'pricing-service.cds']) {
    const ops = operations(file);
    assert.ok(ops.length > 5, file);
    assert.deepEqual(ops.filter((o) => !o.requires).map((o) => o.name), [], `${file}: operations without @requires`);
  }
});

test('every config operation requires PricingAdmin; pricing operations need at least a signed-in user', () => {
  assert.deepEqual(operations('config-service.cds').filter((o) => o.requires !== 'PricingAdmin').map((o) => o.name), []);
  assert.deepEqual(operations('pricing-service.cds').filter((o) => o.requires !== 'authenticated-user').map((o) => o.name), []);
});
