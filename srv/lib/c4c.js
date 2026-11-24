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
// Owner-requested defaults (2026-11-24): the QUA tenant and the integration user are fixed
// facts of this project, so they are the fallback when neither a destination nor the
// Connections tab provides them. The PASSWORD is deliberately NOT here and never will be —
// it comes only from the C4C_PASSWORD environment variable or a BTP destination.
const DEFAULT_C4C_URL = 'https://my352500.crm.ondemand.com';
const DEFAULT_C4C_USERNAME = 'Tss.integration';

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
    const url = (c.url && String(c.url).trim()) || process.env.C4C_URL || DEFAULT_C4C_URL;
    return {
      name,
      url,
      username: process.env.C4C_USERNAME || DEFAULT_C4C_USERNAME,
      password: process.env.C4C_PASSWORD || null, // never defaulted, never stored in config
    };
  };

  return createC4cClient({
    resolveDestination,
    ...(c.servicePath && String(c.servicePath).trim() ? { servicePath: String(c.servicePath).trim() } : {}),
    ...(c.fieldMap && Object.keys(c.fieldMap).length ? { fieldMap: c.fieldMap } : {}),
  });
}

module.exports = { currentC4c };
