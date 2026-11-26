const {
  validateRegionConfig,
  validateAiSuggestion,
  validateSupplierConfig,
  validateRegionRoute,
  validatePartyConfig,
  validateConnectionConfig,
  ConfigValidationError,
} = require('./validate');

const WILDCARD = '*';

/**
 * Shared versioning machinery: save/get/list + effective-dated lookup with a wildcard
 * fallback bucket. Used for both region-config (region, salesOrg) and supplier-config
 * (region, salesOrg, supplier) — same versioning rules, different key shape.
 */
class VersionedBucketStore {
  constructor({ validate, entityLabel, keyOf, wildcardKeyOf }) {
    this.validate = validate;
    this.entityLabel = entityLabel;
    this.keyOf = keyOf;
    this.wildcardKeyOf = wildcardKeyOf;
    this.versionsByKey = new Map();
  }

  saveVersion(doc) {
    this.validate(doc);
    const key = this.keyOf(doc);
    const versions = this.versionsByKey.get(key) || [];
    if (versions.some((v) => v.version === doc.version)) {
      throw new ConfigValidationError(`Version "${doc.version}" already exists for this ${this.entityLabel} (key "${key}").`);
    }
    // Only ACTIVE documents take part in effective-dating. A DRAFT (or REJECTED) one is stored but
    // never resolves for any date, and never closes another version's window.
    if (doc.status === 'ACTIVE') {
      let nextStart = null; // the earliest LATER version's start: a backdated save must not reach past it
      for (const v of versions) {
        if (v.status !== 'ACTIVE' && v.status !== 'SUPERSEDED') continue;
        if (v.validFrom <= doc.validFrom) {
          // v started at or before the new version: from the new start on, the new one replaces it.
          // Close v's window there (never extend it) so no two versions ever cover the same date.
          if (!v.validTo || v.validTo > doc.validFrom) {
            v.validTo = doc.validFrom;
            v.status = 'SUPERSEDED';
          }
        } else if (nextStart === null || v.validFrom < nextStart) {
          nextStart = v.validFrom;
        }
      }
      // A backdated save only covers the gap up to the next existing version, which stays in force.
      if (nextStart !== null && (!doc.validTo || doc.validTo > nextStart)) doc.validTo = nextStart;
    }
    versions.push(doc);
    this.versionsByKey.set(key, versions);
    return doc;
  }

  getVersion(key, version) {
    const versions = this.versionsByKey.get(key) || [];
    return versions.find((v) => v.version === version) || null;
  }

  listVersions(key) {
    return [...(this.versionsByKey.get(key) || [])];
  }

  /** Scans every version ever saved for `key`, not just the current ACTIVE one, and picks
   *  whichever [validFrom, validTo) window contains `date` — reprices historical dates
   *  exactly at the rules that were live then (requirements §5.4). Falls back to
   *  `wildcardKey` if nothing in `key`'s own bucket covers the date. */
  getEffectiveAsOf(key, wildcardKey, date) {
    const specific = this._effectiveInBucket(key, date);
    if (specific) return specific;
    if (key === wildcardKey) return null;
    return this._effectiveInBucket(wildcardKey, date);
  }

  _effectiveInBucket(key, date) {
    const versions = this.versionsByKey.get(key) || [];
    // ACTIVE/SUPERSEDED only (never DRAFT/REJECTED). If more than one window covers the date — which
    // saveVersion prevents but legacy data could contain — the version that started LAST wins, and
    // among equal starts the one saved last: "the most recent rule that has taken effect".
    let best = null;
    for (const v of versions) {
      if (v.status !== 'ACTIVE' && v.status !== 'SUPERSEDED') continue;
      if (!(v.validFrom <= date && (!v.validTo || date < v.validTo))) continue;
      if (best === null || v.validFrom >= best.validFrom) best = v;
    }
    return best;
  }
}

function regionSalesOrgKey(region, salesOrg) {
  return `${region}::${salesOrg}`;
}

function regionRouteKey(ood, salesOrg) {
  return `${ood}::${salesOrg}`;
}

/**
 * In-memory, versioned config + AI-suggestion store. Stands in for the real HANA/Postgres
 * store CAP will own in Phase 2 (`srv/`) — same shape, so swapping the backing store later
 * is a persistence-layer change, not a config-model API change.
 *
 * region-config is scoped by (region, salesOrg): salesOrg "*" is a region-wide default.
 * supplier-config is scoped by supplier ALONE — a supplier is independent of region, it just
 * ships to warehouses in different regions (see supplier-config.schema.json). No wildcard
 * fallback, same as party-config: a supplier either has a document on file or doesn't.
 */
class ConfigStore {
  constructor() {
    this._regionConfigs = new VersionedBucketStore({
      validate: validateRegionConfig,
      entityLabel: 'region/salesOrg',
      keyOf: (doc) => regionSalesOrgKey(doc.region, doc.salesOrg),
    });
    this._supplierConfigs = new VersionedBucketStore({
      validate: validateSupplierConfig,
      entityLabel: 'supplier',
      keyOf: (doc) => doc.supplier,
    });
    this._regionRoutes = new VersionedBucketStore({
      validate: validateRegionRoute,
      entityLabel: 'ood/salesOrg',
      keyOf: (doc) => regionRouteKey(doc.ood, doc.salesOrg),
    });
    this._partyConfigs = new VersionedBucketStore({
      validate: validatePartyConfig,
      entityLabel: 'customerId',
      keyOf: (doc) => doc.customerId,
    });
    this._connectionConfigs = new VersionedBucketStore({
      validate: validateConnectionConfig,
      entityLabel: 'name',
      keyOf: (doc) => doc.name,
    });
    this.suggestions = new Map();
  }

  saveVersion(config) {
    return this._regionConfigs.saveVersion(config);
  }

  getVersion(region, salesOrg, version) {
    return this._regionConfigs.getVersion(regionSalesOrgKey(region, salesOrg), version);
  }

  listVersions(region, salesOrg) {
    return this._regionConfigs.listVersions(regionSalesOrgKey(region, salesOrg));
  }

  getEffectiveAsOf(region, salesOrg, date) {
    return this._regionConfigs.getEffectiveAsOf(
      regionSalesOrgKey(region, salesOrg),
      regionSalesOrgKey(region, WILDCARD),
      date,
    );
  }

  saveSupplierConfig(config) {
    return this._supplierConfigs.saveVersion(config);
  }

  getSupplierConfigVersion(supplier, version) {
    return this._supplierConfigs.getVersion(supplier, version);
  }

  listSupplierConfigVersions(supplier) {
    return this._supplierConfigs.listVersions(supplier);
  }

  /** No wildcard fallback — a supplier either has master data on file or doesn't, same as
   *  party-config. */
  getEffectiveSupplierConfig(supplier, date) {
    return this._supplierConfigs.getEffectiveAsOf(supplier, supplier, date);
  }

  /** Every supplier with an effective document as of `date` — global, not scoped to any
   *  region, since a supplier ships to warehouses across regions. */
  listSuppliers(date) {
    const seen = new Map();
    for (const supplier of this._supplierConfigs.versionsByKey.keys()) {
      const effective = this.getEffectiveSupplierConfig(supplier, date);
      if (effective) seen.set(supplier, effective);
    }
    return [...seen.values()];
  }

  /** The Origins of Data that route to `region` as of `date` (e.g. EUROPE -> ['SAP']). Used to
   *  default a line's Origin of Data when it has none; only meaningful when it is unambiguous. */
  listOodsForRegion(region, date) {
    const oods = new Set();
    for (const key of this._regionRoutes.versionsByKey.keys()) {
      const effective = this._regionRoutes.getEffectiveAsOf(key, key, date);
      if (effective && effective.region === region) oods.add(effective.ood);
    }
    return [...oods];
  }

  saveRegionRoute(route) {
    return this._regionRoutes.saveVersion(route);
  }

  listRegionRouteVersions(ood, salesOrg) {
    return this._regionRoutes.listVersions(regionRouteKey(ood, salesOrg));
  }

  /** Falls back salesOrg -> "*" (an ood-wide default routing), same convention as
   *  region-config and supplier-config. */
  getEffectiveRegionRoute(ood, salesOrg, date) {
    return this._regionRoutes.getEffectiveAsOf(
      regionRouteKey(ood, salesOrg),
      regionRouteKey(ood, WILDCARD),
      date,
    );
  }

  savePartyConfig(config) {
    return this._partyConfigs.saveVersion(config);
  }

  listPartyConfigVersions(customerId) {
    return this._partyConfigs.listVersions(customerId);
  }

  /** No wildcard fallback — a customer either has master data on file or doesn't; there's
   *  no natural "default customer" the way "*" salesOrg/supplier stand in for one. */
  getEffectivePartyConfig(customerId, date) {
    return this._partyConfigs.getEffectiveAsOf(customerId, customerId, date);
  }

  /** One global document (name 'GLOBAL'): the integration endpoints the outbound adapters
   *  use. Versioned/effective-dated like everything else; holds NO credentials ever. */
  saveConnectionConfig(config) {
    return this._connectionConfigs.saveVersion(config);
  }

  listConnectionConfigVersions() {
    return this._connectionConfigs.listVersions('GLOBAL');
  }

  getEffectiveConnectionConfig(date) {
    return this._connectionConfigs.getEffectiveAsOf('GLOBAL', 'GLOBAL', date);
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

module.exports = { ConfigStore, WILDCARD_SALES_ORG: WILDCARD, WILDCARD_SUPPLIER: WILDCARD };
