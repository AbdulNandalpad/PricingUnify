const path = require('node:path');

// CAP resolves its project root (and reads the "cds" config) from process.cwd() — force it
// to the repo root regardless of how this script was invoked (`node srv/server.js` from
// the repo root, `npm start --workspace=srv` from srv/, etc.), so the model (srv/*.cds)
// and the cds config in the root package.json are always found consistently.
process.chdir(path.join(__dirname, '..'));

const cds = require('@sap/cds');
const { store } = require('./lib/store');
const { CdsBackend } = require('./lib/backend');
const { seed } = require('./lib/seed');

const LOG = cds.log('pricing');

/**
 * Boot sequence (ARCHITECTURE_V2 §4.1). `cds.server` connects the database and serves the
 * models, then awaits every 'served' listener BEFORE it starts listening — so by the time
 * the first request arrives the schema exists, the ConfigStore holds every persisted
 * document, and an empty database has been seeded exactly once.
 *   default profile  -> SQLite file db.sqlite (gitignored), survives restarts
 *   CDS_ENV=test     -> SQLite in memory (never touches db.sqlite)
 *   [production]     -> HANA, deployed separately (cds deploy --to hana); never auto-deployed
 */
cds.on('served', async () => {
  await ensureSchema();
  await store.load(new CdsBackend(cds.db));
  if (store.isEmpty) {
    seed(store);
    await store.flush();
    LOG.info('seeded', store.index.size, 'config buckets into an empty ConfigDocuments table');
  } else {
    LOG.info('loaded', store.index.size, 'config buckets from ConfigDocuments');
  }
});

/** Deploys the CDS model when the tables are missing — a fresh db.sqlite or the in-memory
 *  test database. An existing schema is left alone (a drop/create would wipe every stored
 *  document); schema changes on a populated dev database mean deleting db.sqlite. */
async function ensureSchema() {
  if (cds.db.kind !== 'sqlite') return; // HANA/Postgres are deployed by their own tooling
  try {
    await cds.db.run(cds.ql.SELECT.one.from('tss.pricing.ConfigDocuments').columns('kind'));
  } catch {
    await cds.deploy(cds.model).to(cds.db, { silent: true });
  }
}

require('@sap/cds/server')();
