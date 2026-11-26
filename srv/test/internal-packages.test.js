const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const { install, INTERNAL } = require('../lib/internal-packages');

test('internal packages resolve from the app folder when the node_modules links are broken (Cloud Foundry layout)', () => {
  const root = path.join(__dirname, '..', '..');
  install(root);
  // a "requiring file" far away from any node_modules that could hold the workspace links
  const parent = new Module(path.join(os.tmpdir(), 'tss-no-links', 'x.js'));
  parent.filename = path.join(os.tmpdir(), 'tss-no-links', 'x.js');
  parent.paths = [path.join(os.tmpdir(), 'tss-no-links', 'node_modules')];
  for (const name of INTERNAL) {
    const resolved = Module._resolveFilename(`@tss-pricing/${name}`, parent);
    assert.ok(resolved.startsWith(path.join(root, name)), `${name} -> ${resolved}`);
  }
  assert.throws(() => Module._resolveFilename('@tss-pricing/mcp-server', parent), /Cannot find module/);
  assert.throws(() => Module._resolveFilename('left-pad-does-not-exist', parent), /Cannot find module/);
});

test('installing twice does not stack the hook', () => {
  const before = Module._resolveFilename;
  install();
  assert.equal(Module._resolveFilename, before);
});
