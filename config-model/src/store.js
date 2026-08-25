const { validateRegionConfig, validateAiSuggestion, ConfigValidationError } = require('./validate');

/**
 * In-memory, versioned config + AI-suggestion store. Stands in for the real HANA/Postgres
 * store CAP will own in Phase 2 (`srv/`) — same shape, so swapping the backing store later
 * is a persistence-layer change, not a config-model API change.
 */
class ConfigStore {
  constructor() {
    this.versionsByRegion = new Map();
    this.suggestions = new Map();
  }

  saveVersion(config) {
    validateRegionConfig(config);
    const versions = this.versionsByRegion.get(config.region) || [];
    if (versions.some((v) => v.version === config.version)) {
      throw new ConfigValidationError(`Version "${config.version}" already exists for region "${config.region}".`);
    }
    if (config.status === 'ACTIVE') {
      for (const v of versions) {
        if (v.status === 'ACTIVE') v.status = 'SUPERSEDED';
      }
    }
    versions.push(config);
    this.versionsByRegion.set(config.region, versions);
    return config;
  }

  getVersion(region, version) {
    const versions = this.versionsByRegion.get(region) || [];
    return versions.find((v) => v.version === version) || null;
  }

  listVersions(region) {
    return [...(this.versionsByRegion.get(region) || [])];
  }

  /** A December quote reprices exactly at December rules (requirements §5.4) — this scans
   *  every version ever saved, not just the current ACTIVE one, and picks whichever
   *  [validFrom, validTo) window contains the given date. */
  getEffectiveAsOf(region, date) {
    const versions = this.versionsByRegion.get(region) || [];
    return versions.find((v) => v.validFrom <= date && (!v.validTo || date < v.validTo) && v.status !== 'REJECTED') || null;
  }

  saveSuggestion(suggestion) {
    validateAiSuggestion(suggestion);
    this.suggestions.set(suggestion.id, suggestion);
    return suggestion;
  }

  getSuggestion(id) {
    return this.suggestions.get(id) || null;
  }

  listSuggestions(region, status) {
    return [...this.suggestions.values()].filter(
      (s) => (!region || s.region === region) && (!status || s.status === status),
    );
  }
}

module.exports = { ConfigStore };
