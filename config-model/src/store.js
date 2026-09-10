const { validateDocument, validateAiSuggestion, validateRoutingBooks, ConfigValidationError } = require('./validate');
const { KINDS, KIND_NAMES, SUGGESTION_KIND, WILDCARD, isKind, docKeyOf, wildcardKeyOf } = require('./kinds');
const { diff } = require('./diff');

const LIVE_STATUSES = new Set(['ACTIVE', 'SUPERSEDED']);

function indexKey(kind, docKey) {
  return `${kind}|${docKey}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Versioned, effective-dated store for every config document kind (ARCHITECTURE_V2 §3),
 * behind one API keyed by (kind, docKey). The in-memory index is the read model; every
 * write goes through a StoreBackend (see backend.js) — MemoryBackend in tests, CdsBackend in
 * srv. Loaded once at boot via `load(backend)`.
 *
 * Two write styles, one plan:
 *  - `save/publish/discard` (async) write the backend FIRST, then apply to the index — a
 *    failed write leaves the index untouched.
 *  - `saveSync` and the legacy `saveVersion/saveSupplierConfig/...` aliases apply to the
 *    index immediately and write behind; `await flush()` surfaces any write failure. Kept so
 *    seeds and the pre-v2 test suite stay synchronous.
 *
 * Lifecycle: DRAFT documents are never returned by getEffective. `publish` flips DRAFT ->
 * ACTIVE, supersedes the previous ACTIVE in the same bucket and closes its window, exactly
 * as saving an ACTIVE document directly always has.
 */
class ConfigStore {
  constructor() {
    this.index = new Map();
    this.suggestions = new Map();
    this.backend = null;
    this._pending = Promise.resolve();
    this._writeErrors = [];
  }

  // ---- persistence ------------------------------------------------------------------

  async load(backend) {
    this.backend = backend;
    this.index = new Map();
    this.suggestions = new Map();
    const rows = await backend.loadAll();
    for (const row of rows) {
      if (row.kind === SUGGESTION_KIND) {
        this.suggestions.set(row.docKey, row.doc);
        continue;
      }
      if (!isKind(row.kind)) continue;
      this._bucket(row.kind, row.docKey, true).push(row.doc);
    }
    return this;
  }

  /** Awaits every write-behind from the sync API; rethrows the first failure. */
  async flush() {
    await this._pending;
    if (this._writeErrors.length) {
      const [err] = this._writeErrors;
      this._writeErrors = [];
      throw err;
    }
  }

  get isEmpty() {
    return this.index.size === 0 && this.suggestions.size === 0;
  }

  async _write(ops) {
    if (!this.backend || ops.length === 0) return;
    if (typeof this.backend.writeMany === 'function') return this.backend.writeMany(ops);
    for (const { op, envelope } of ops) await this.backend[op](envelope);
  }

  _enqueue(ops) {
    this._pending = this._pending.then(() => this._write(ops)).catch((err) => {
      this._writeErrors.push(err);
    });
  }

  _envelope(kind, docKey, doc) {
    return {
      kind,
      docKey,
      version: String(doc.version),
      status: doc.status,
      validFrom: doc.validFrom || null,
      validTo: doc.validTo || null,
      doc,
      createdBy: (doc.provenance && doc.provenance.authoredBy) || doc.requestedBy || null,
      createdAt: nowIso(),
    };
  }

  // ---- index helpers ----------------------------------------------------------------

  _bucket(kind, docKey, create = false) {
    const k = indexKey(kind, docKey);
    let bucket = this.index.get(k);
    if (!bucket && create) {
      bucket = [];
      this.index.set(k, bucket);
    }
    return bucket || [];
  }

  _requireKind(kind) {
    if (!isKind(kind)) throw new ConfigValidationError(`Unknown config document kind "${kind}".`, [`Known kinds: ${KIND_NAMES.join(', ')}`]);
  }

  _find(kind, key, version) {
    return this._bucket(kind, key).find((v) => String(v.version) === String(version)) || null;
  }

  /** ACTIVE version of `id` exists for `kind` (any date) — the routing cross-check. */
  bookExists(kind, id) {
    return this._bucket(kind, id).some((v) => v.status === 'ACTIVE');
  }

  _validate(kind, doc) {
    validateDocument(kind, doc);
    if (kind === 'routing-rules' && doc.status === 'ACTIVE') validateRoutingBooks(doc, (k, id) => this.bookExists(k, id));
  }

  // ---- write plans ------------------------------------------------------------------

  /** Everything a save needs, computed before anything is touched: validation, the
   *  supersede patches, the backend ops, and an `apply()` that mutates the index. */
  _planSave(kind, doc) {
    this._requireKind(kind);
    this._validate(kind, doc);
    const key = docKeyOf(kind, doc);
    const bucket = this._bucket(kind, key);
    if (bucket.some((v) => String(v.version) === String(doc.version))) {
      throw new ConfigValidationError(`Version "${doc.version}" already exists for this ${KINDS[kind].label} (key "${key}").`);
    }
    const patches = doc.status === 'ACTIVE' ? this._supersedePatches(bucket, doc.validFrom) : [];
    const ops = [
      ...patches.map((p) => ({ op: 'update', envelope: this._envelope(kind, key, { ...p.target, ...p.patch }) })),
      { op: 'append', envelope: this._envelope(kind, key, doc) },
    ];
    const apply = () => {
      for (const p of patches) Object.assign(p.target, p.patch);
      this._bucket(kind, key, true).push(doc);
      return doc;
    };
    return { key, ops, apply };
  }

  /** Close the superseded version's window at the new one's start, so overlapping validFrom
   *  dates can't leave two versions both matching the same lookup date. */
  _supersedePatches(bucket, validFrom) {
    return bucket
      .filter((v) => v.status === 'ACTIVE')
      .map((v) => ({ target: v, patch: { status: 'SUPERSEDED', validTo: !v.validTo || v.validTo > validFrom ? validFrom : v.validTo } }));
  }

  _planPublish(kind, key, version, { effectiveFrom, publishedBy, note } = {}) {
    this._requireKind(kind);
    if (!publishedBy) throw new ConfigValidationError('publish requires publishedBy — nothing goes live without a named user.');
    const draft = this._find(kind, key, version);
    if (!draft) throw new ConfigValidationError(`No version "${version}" of ${kind} "${key}".`, ['NOT_FOUND']);
    if (draft.status !== 'DRAFT') throw new ConfigValidationError(`Version "${version}" of ${kind} "${key}" is ${draft.status}, not DRAFT — only drafts can be published.`);

    const bucket = this._bucket(kind, key);
    const current = bucket.find((v) => v.status === 'ACTIVE') || null;
    const next = {
      ...draft,
      status: 'ACTIVE',
      validFrom: effectiveFrom || draft.validFrom,
      validTo: draft.validTo && effectiveFrom && draft.validTo <= effectiveFrom ? null : draft.validTo ?? null,
      supersedes: current ? current.version : draft.supersedes ?? null,
      provenance: { ...(draft.provenance || {}), publishedBy, publishedAt: nowIso(), ...(note ? { note } : {}) },
    };
    this._validate(kind, next);

    const patches = this._supersedePatches(bucket, next.validFrom);
    const ops = [
      ...patches.map((p) => ({ op: 'update', envelope: this._envelope(kind, key, { ...p.target, ...p.patch }) })),
      { op: 'update', envelope: this._envelope(kind, key, next) },
    ];
    const apply = () => {
      for (const p of patches) Object.assign(p.target, p.patch);
      Object.assign(draft, next);
      return draft;
    };
    return { ops, apply };
  }

  _planDiscard(kind, key, version) {
    this._requireKind(kind);
    const draft = this._find(kind, key, version);
    if (!draft) throw new ConfigValidationError(`No version "${version}" of ${kind} "${key}".`, ['NOT_FOUND']);
    if (draft.status !== 'DRAFT') throw new ConfigValidationError(`Version "${version}" of ${kind} "${key}" is ${draft.status} — only drafts can be discarded.`);
    const next = { ...draft, status: 'REJECTED' };
    const ops = [{ op: 'update', envelope: this._envelope(kind, key, next) }];
    const apply = () => Object.assign(draft, next);
    return { ops, apply };
  }

  // ---- generic API ------------------------------------------------------------------

  /** Backend first, then index. DRAFT or ACTIVE per doc.status. */
  async save(kind, doc) {
    const plan = this._planSave(kind, doc);
    await this._write(plan.ops);
    return plan.apply();
  }

  /** Index now, backend write-behind (see flush()). */
  saveSync(kind, doc) {
    const plan = this._planSave(kind, doc);
    const saved = plan.apply();
    this._enqueue(plan.ops);
    return saved;
  }

  async publish(kind, key, version, options) {
    const plan = this._planPublish(kind, key, version, options);
    await this._write(plan.ops);
    return plan.apply();
  }

  async discard(kind, key, version) {
    const plan = this._planDiscard(kind, key, version);
    await this._write(plan.ops);
    return plan.apply();
  }

  getVersion(kind, key, version) {
    if (!isKind(kind)) return this._find('region-config', `${kind}::${key}`, version); // legacy (region, salesOrg, version)
    return this._find(kind, key, version);
  }

  listVersions(kind, key) {
    if (!isKind(kind)) return [...this._bucket('region-config', `${kind}::${key}`)]; // legacy (region, salesOrg)
    return [...this._bucket(kind, key)];
  }

  /** Scans every version ever saved for `key`, not just the current ACTIVE one, and picks
   *  whichever [validFrom, validTo) window contains `date` — reprices historical dates
   *  exactly at the rules that were live then (requirements §5.4). DRAFT and REJECTED
   *  versions never price. Falls back to the kind's wildcard key when nothing covers the date. */
  getEffective(kind, key, date) {
    this._requireKind(kind);
    const specific = this._effectiveInBucket(kind, key, date);
    if (specific) return specific;
    const wildcard = wildcardKeyOf(kind, key);
    return wildcard ? this._effectiveInBucket(kind, wildcard, date) : null;
  }

  _effectiveInBucket(kind, key, date) {
    return this._bucket(kind, key).find((v) => LIVE_STATUSES.has(v.status) && v.validFrom <= date && (!v.validTo || date < v.validTo)) || null;
  }

  listKeys(kind) {
    this._requireKind(kind);
    const prefix = `${kind}|`;
    return [...this.index.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  /** Every effective document of `kind` as of `date`, keyed by docKey. */
  listEffective(kind, date) {
    const out = {};
    for (const key of this.listKeys(kind)) {
      const doc = this._effectiveInBucket(kind, key, date);
      if (doc) out[key] = doc;
    }
    return out;
  }

  listDrafts(kind) {
    const out = [];
    for (const [k, bucket] of this.index) {
      const sep = k.indexOf('|');
      const docKind = k.slice(0, sep);
      if (kind && docKind !== kind) continue;
      for (const doc of bucket) {
        if (doc.status === 'DRAFT') out.push({ kind: docKind, key: k.slice(sep + 1), version: doc.version, validFrom: doc.validFrom, doc });
      }
    }
    return out;
  }

  /** Next free `YYYY-MM-DD-rN` draft version for a bucket. */
  suggestVersion(kind, key, date = nowIso().slice(0, 10)) {
    const prefix = `${date}-r`;
    const taken = this._bucket(kind, key).filter((v) => String(v.version).startsWith(prefix)).length;
    return `${prefix}${taken + 1}`;
  }

  diff(a, b, options) {
    return diff(a, b, options);
  }

  // ---- legacy aliases (pre-v2 API, kept so existing callers and tests stay green) --------

  saveVersion(config) {
    return this.saveSync('region-config', config);
  }

  getEffectiveAsOf(region, salesOrg, date) {
    return this.getEffective('region-config', `${region}::${salesOrg}`, date);
  }

  saveSupplierConfig(config) {
    return this.saveSync('supplier-config', config);
  }

  getSupplierConfigVersion(supplier, version) {
    return this._find('supplier-config', supplier, version);
  }

  listSupplierConfigVersions(supplier) {
    return [...this._bucket('supplier-config', supplier)];
  }

  getEffectiveSupplierConfig(supplier, date) {
    return this.getEffective('supplier-config', supplier, date);
  }

  /** Every supplier with an effective document as of `date` — global, not scoped to any
   *  region, since a supplier ships to warehouses across regions. */
  listSuppliers(date) {
    return Object.values(this.listEffective('supplier-config', date));
  }

  saveRegionRoute(route) {
    return this.saveSync('region-route', route);
  }

  listRegionRouteVersions(ood, salesOrg) {
    return [...this._bucket('region-route', `${ood}::${salesOrg}`)];
  }

  getEffectiveRegionRoute(ood, salesOrg, date) {
    return this.getEffective('region-route', `${ood}::${salesOrg}`, date);
  }

  savePartyConfig(config) {
    return this.saveSync('party-config', config);
  }

  listPartyConfigVersions(customerId) {
    return [...this._bucket('party-config', customerId)];
  }

  getEffectivePartyConfig(customerId, date) {
    return this.getEffective('party-config', customerId, date);
  }

  // ---- AI suggestions -------------------------------------------------------------------

  saveSuggestion(suggestion) {
    validateAiSuggestion(suggestion);
    const isNew = !this.suggestions.has(suggestion.id);
    this.suggestions.set(suggestion.id, suggestion);
    this._enqueue([{ op: isNew ? 'append' : 'update', envelope: this._suggestionEnvelope(suggestion) }]);
    return suggestion;
  }

  /** Status/review changes on an existing suggestion (approve / reject). */
  updateSuggestion(suggestion) {
    if (!this.suggestions.has(suggestion.id)) return this.saveSuggestion(suggestion);
    validateAiSuggestion(suggestion);
    this._enqueue([{ op: 'update', envelope: this._suggestionEnvelope(suggestion) }]);
    return suggestion;
  }

  _suggestionEnvelope(s) {
    return { kind: SUGGESTION_KIND, docKey: s.id, version: '1', status: s.status, validFrom: null, validTo: null, doc: s, createdBy: s.requestedBy || null, createdAt: s.createdAt || nowIso() };
  }

  getSuggestion(id) {
    return this.suggestions.get(id) || null;
  }

  /** `filter` is a legacy region string, or { targetKind, targetKey, region }. */
  listSuggestions(filter, status) {
    const f = typeof filter === 'string' ? { region: filter } : filter || {};
    return [...this.suggestions.values()].filter(
      (s) =>
        (!f.region || s.region === f.region) &&
        (!f.targetKind || s.targetKind === f.targetKind) &&
        (!f.targetKey || s.targetKey === f.targetKey) &&
        (!status || s.status === status),
    );
  }
}

module.exports = { ConfigStore, KINDS, KIND_NAMES, WILDCARD_SALES_ORG: WILDCARD, WILDCARD_SUPPLIER: WILDCARD };
