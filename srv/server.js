const path = require('node:path');

// CAP resolves its project root (and reads the "cds" config) from process.cwd() — force it
// to the repo root regardless of how this script was invoked (`node srv/server.js` from
// the repo root, `npm start --workspace=srv` from srv/, etc.), so the model (srv/*.cds)
// and the cds config in the root package.json are always found consistently.
process.chdir(path.join(__dirname, '..'));

const { seed } = require('./lib/seed');

seed();

require('@sap/cds/server')();
