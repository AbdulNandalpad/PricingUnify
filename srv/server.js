const path = require('node:path');

// CAP resolves its project root (and reads the "cds" config) from process.cwd() — force it
// to the repo root regardless of how this script was invoked (`node srv/server.js` from
// the repo root, `npm start --workspace=srv` from srv/, etc.), so the model (srv/*.cds)
// and the cds config in the root package.json are always found consistently.
process.chdir(path.join(__dirname, '..'));

const { seed } = require('./lib/seed');

seed();

// Serve the SAPUI5 app (app-c4c/webapp) same-origin at /app-c4c in local dev, so the UI can
// call /rest/* with no CORS and CAP's mocked basic auth just works in the browser. In CF the
// approuter owns routing/auth and serves the html5 module instead (Phase 4) — this mount is
// a dev convenience, not the deployment path.
const cds = require('@sap/cds');
cds.on('bootstrap', (app) => {
  const express = require('express');
  app.use('/app-c4c', express.static(path.join(__dirname, '..', 'app-c4c', 'webapp')));
});

require('@sap/cds/server')();
