const Module = require('node:module');
const path = require('node:path');

/**
 * Cloud Foundry's Node.js buildpack installs node_modules under /home/vcap/deps/0, away from the app, so the
 * npm-workspace links to our own packages (node_modules/@tss-pricing/engine-core -> ../../engine-core, ...) point
 * at deps/0/engine-core, which does not exist: "Cannot find module '@tss-pricing/config-model'" (first MTA deploy,
 * 2026-11-26). This fallback resolves those three internal packages from the app folder WHEN the normal lookup
 * fails — where the links work (local dev, tests) nothing changes.
 */
const PREFIX = '@tss-pricing/';
const INTERNAL = ['engine-core', 'config-model', 'api6-client'];

function install(root = path.join(__dirname, '..', '..')) {
  const original = Module._resolveFilename;
  if (original.__tssInternalPackages) return;
  const resolve = function (request, ...rest) {
    try {
      return original.call(this, request, ...rest);
    } catch (err) {
      if (err && err.code === 'MODULE_NOT_FOUND' && typeof request === 'string' && request.startsWith(PREFIX)) {
        const name = request.slice(PREFIX.length).split('/')[0];
        if (INTERNAL.includes(name)) {
          return original.call(this, path.join(root, name, request.slice(PREFIX.length + name.length)), ...rest);
        }
      }
      throw err;
    }
  };
  resolve.__tssInternalPackages = true;
  Module._resolveFilename = resolve;
}

module.exports = { install, INTERNAL };
