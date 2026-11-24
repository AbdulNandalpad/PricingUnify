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
function envDestinations(name) {
  try {
    const all = JSON.parse(process.env.destinations || '[]');
    return all.find((d) => d.name === name) || null;
  } catch {
    return null;
  }
}

function currentC4c() {
  const conn = store.getEffectiveConnectionConfig(todayIso());
  const c = (conn && conn.c4c) || {};

  // Destination resolution chain: a full BTP/env destination wins; else the admin-maintained
  // C4C URL from connection-config, with the technical user's credentials taken ONLY from
  // the environment (C4C_USERNAME / C4C_PASSWORD) — a URL is config, credentials never are.
  const resolveDestination = (name) => {
    const fromEnv = envDestinations(name);
    if (fromEnv) return fromEnv;
    const url = c.url && String(c.url).trim();
    if (!url) return null;
    return {
      name,
      url,
      username: process.env.C4C_USERNAME || null,
      password: process.env.C4C_PASSWORD || null,
    };
  };

  return createC4cClient({
    resolveDestination,
    ...(c.servicePath && String(c.servicePath).trim() ? { servicePath: String(c.servicePath).trim() } : {}),
    ...(c.fieldMap && Object.keys(c.fieldMap).length ? { fieldMap: c.fieldMap } : {}),
  });
}

module.exports = { currentC4c };
