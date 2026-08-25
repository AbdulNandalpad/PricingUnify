const { ConfigStore } = require('@tss-pricing/config-model');

/**
 * Process-wide, in-memory ConfigStore — same shape the real HANA/Postgres-backed store
 * will have once persistence lands; today it's just seeded fresh on every boot (see
 * seed.js). Singleton so every service handler shares one store.
 */
const store = new ConfigStore();

module.exports = { store };
