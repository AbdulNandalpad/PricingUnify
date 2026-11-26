const { createC4cClient } = require('./c4c-client');
const { store } = require('./store');
const environment = require('./environment');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The C4C adapter honoring the admin-maintained connection-config: service path and field
 * map are UI-editable (they are tenant facts, not secrets); the destination itself —
 * URL + technical user — stays in the BTP destination / environment, never in config.
 * Built per call (cheap): a save in the admin UI applies immediately.
 */
// Which tenant / user is decided by TSS_ENVIRONMENT (lib/environment.js): QUA has a built-in profile (the
// my352500 tenant + the integration user, owner-requested 2026-11-24); PROD takes URL and user from
// C4C_URL_PROD / C4C_USERNAME_PROD (or the Connections tab). The PASSWORD is deliberately NOT defaulted and
// never will be — C4C_PASSWORD_<ENV> (unsuffixed C4C_PASSWORD for QUA only) or a BTP destination.

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
  const c = environment.honours(conn) ? ((conn && conn.c4c) || {}) : {}; // a document saved for another environment is ignored

  // Destination resolution chain: a full BTP/env destination wins; else the admin-maintained
  // C4C URL from connection-config, with the technical user's credentials taken ONLY from
  // the environment (C4C_USERNAME / C4C_PASSWORD) — a URL is config, credentials never are.
  const resolveDestination = (name) => {
    const fromEnv = envDestinations(name);
    if (fromEnv) return fromEnv;
    const url = (c.url && String(c.url).trim()) || environment.urlVar('C4C_URL') || environment.profile().c4cUrl || null;
    return {
      name,
      url,
      username: environment.secretVar('C4C_USERNAME') || environment.profile().c4cUsername || null,
      password: environment.secretVar('C4C_PASSWORD') || null, // never defaulted, never stored in config
    };
  };

  return createC4cClient({
    resolveDestination,
    ...(c.servicePath && String(c.servicePath).trim() ? { servicePath: String(c.servicePath).trim() } : {}),
    ...(c.fieldMap && Object.keys(c.fieldMap).length ? { fieldMap: c.fieldMap } : {}),
  });
}

module.exports = { currentC4c };
