const {
  validateRegionConfig,
  validateAiSuggestion,
  validateSupplierConfig,
  validateRegionRoute,
  validatePartyConfig,
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
    if (doc.status === 'ACTIVE') {
      for (const v of versions) {
        if (v.status !== 'ACTIVE') continue;
        v.status = 'SUPERSEDED';
        // Close the superseded version's window at the new one's start, so overlapping
        // validFrom dates can't leave two versions both matching the same lookup date.
        if (!v.validTo || v.validTo > doc.validFrom) v.validTo = doc.validFrom;
      }
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
    return versions.find((v) => v.validFrom <= date && (!v.validTo || date < v.validTo) && v.status !== 'REJECTED') || null;
  }
}

function regionSalesOrgKey(region, salesOrg) {
  return `${region}::${salesOrg}`;
}

function supplierKey(region, salesOrg, supplier) {
  return `${region}::${salesOrg}::${supplier}`;
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
 * supplier-config is scoped by (region, salesOrg, supplier): supplier "*" is a region-wide
 * default landed-cost adder set, and any supplier-specific document overrides it for dates
 * it covers — see getEffectiveSupplierConfig.
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
      entityLabel: 'region/salesOrg/supplier',
      keyOf: (doc) => supplierKey(doc.region, doc.salesOrg, doc.supplier),
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

  getSupplierConfigVersion(region, salesOrg, supplier, version) {
    return this._supplierConfigs.getVersion(supplierKey(region, salesOrg, supplier), version);
  }

  listSupplierConfigVersions(region, salesOrg, supplier) {
    return this._supplierConfigs.listVersions(supplierKey(region, salesOrg, supplier));
  }

  /** Falls back supplier -> "*" (region-wide default adders), same convention as
   *  region-config's salesOrg fallback — a supplier only needs its own document where its
   *  terms actually diverge from the default. */
  getEffectiveSupplierConfig(region, salesOrg, supplier, date) {
    return this._supplierConfigs.getEffectiveAsOf(
      supplierKey(region, salesOrg, supplier),
      supplierKey(region, salesOrg, WILDCARD),
      date,
    );
  }

  /** Every named supplier with an effective config for (region, salesOrg) as of `date` —
   *  scans both the sales-org-specific and "*" buckets, resolves each supplier through the
   *  normal effective lookup, and excludes the "*" wildcard default itself (it's a fallback,
   *  not a supplier anyone can pick from a dropdown). */
  listSuppliers(region, salesOrg, date) {
    const seen = new Map();
    for (const key of this._supplierConfigs.versionsByKey.keys()) {
      const [r, so, supplier] = key.split('::');
      if (r !== region || (so !== salesOrg && so !== WILDCARD)) continue;
      if (supplier === WILDCARD || seen.has(supplier)) continue;
      const effective = this.getEffectiveSupplierConfig(region, salesOrg, supplier, date);
      if (effective) seen.set(supplier, effective);
    }
    return [...seen.values()];
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
