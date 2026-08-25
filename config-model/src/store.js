const { validateRegionConfig, validateAiSuggestion, ConfigValidationError } = require('./validate');

const WILDCARD_SALES_ORG = '*';

function bucketKey(region, salesOrg) {
  return `${region}::${salesOrg}`;
}

/**
 * In-memory, versioned config + AI-suggestion store. Stands in for the real HANA/Postgres
 * store CAP will own in Phase 2 (`srv/`) — same shape, so swapping the backing store later
 * is a persistence-layer change, not a config-model API change.
 *
 * Configs are scoped by (region, salesOrg), not region alone: salesOrg "*" is a region-wide
 * default, and any sales-org-specific document overrides it for dates it covers — see
 * getEffectiveAsOf.
 */
class ConfigStore {
  constructor() {
    this.versionsByKey = new Map();
    this.suggestions = new Map();
  }

  saveVersion(config) {
    validateRegionConfig(config);
    const key = bucketKey(config.region, config.salesOrg);
    const versions = this.versionsByKey.get(key) || [];
    if (versions.some((v) => v.version === config.version)) {
      throw new ConfigValidationError(
        `Version "${config.version}" already exists for region "${config.region}" / salesOrg "${config.salesOrg}".`,
      );
    }
    if (config.status === 'ACTIVE') {
      for (const v of versions) {
        if (v.status !== 'ACTIVE') continue;
        v.status = 'SUPERSEDED';
        // Close the superseded version's window at the new one's start, so overlapping
        // validFrom dates (e.g. an AI suggestion applied with no explicit new effective
        // date) can't leave two versions both matching the same lookup date.
        if (!v.validTo || v.validTo > config.validFrom) {
          v.validTo = config.validFrom;
        }
      }
    }
    versions.push(config);
    this.versionsByKey.set(key, versions);
    return config;
  }

  getVersion(region, salesOrg, version) {
    const versions = this.versionsByKey.get(bucketKey(region, salesOrg)) || [];
    return versions.find((v) => v.version === version) || null;
  }

  listVersions(region, salesOrg) {
    return [...(this.versionsByKey.get(bucketKey(region, salesOrg)) || [])];
  }

  /** A December quote reprices exactly at December rules (requirements §5.4) — this scans
   *  every version ever saved for the exact (region, salesOrg), not just the current
   *  ACTIVE one, and picks whichever [validFrom, validTo) window contains the given date.
   *  If no sales-org-specific document covers that date, falls back to the region-wide
   *  "*" default — a sales org only needs its own config where it actually differs. */
  getEffectiveAsOf(region, salesOrg, date) {
    const specific = this._effectiveInBucket(region, salesOrg, date);
    if (specific) return specific;
    if (salesOrg === WILDCARD_SALES_ORG) return null;
    return this._effectiveInBucket(region, WILDCARD_SALES_ORG, date);
  }

  _effectiveInBucket(region, salesOrg, date) {
    const versions = this.versionsByKey.get(bucketKey(region, salesOrg)) || [];
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

module.exports = { ConfigStore, WILDCARD_SALES_ORG };
