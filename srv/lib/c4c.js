const { createC4cClient } = require('./c4c-client');
const { store } = require('./store');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The C4C adapter honoring the admin-maintained connection-config: service path and field
 * map are UI-editable (they are tenant facts, not secrets); the destination itself —
 * URL + technical user — stays in the BTP destination / environment, never in config.
 * Built per call (cheap): a save in the admin UI applies immediately.
 */
function currentC4c() {
  const conn = store.getEffectiveConnectionConfig(todayIso());
  const c = (conn && conn.c4c) || {};
  return createC4cClient({
    ...(c.servicePath && String(c.servicePath).trim() ? { servicePath: String(c.servicePath).trim() } : {}),
    ...(c.fieldMap && Object.keys(c.fieldMap).length ? { fieldMap: c.fieldMap } : {}),
  });
}

module.exports = { currentC4c };
