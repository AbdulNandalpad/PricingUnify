const { suggestConfigChange, applySuggestion, rejectSuggestion, ConfigValidationError, KINDS } = require('@tss-pricing/config-model');
const { validateFormula } = require('@tss-pricing/engine-core');
const { store } = require('./lib/store');
const { getAiClientOrNull } = require('./lib/ai');
const { requireUserPrincipal } = require('./lib/principal');
const { normalizeKey, requireKind } = require('./lib/keys');
const { todayIso } = require('./lib/pricing');

const NESTED_WITH_PROVENANCE = ['buildUp', 'constraints', 'resolution'];

/**
 * Stamps a human edit's provenance server-side (never trusted from the payload — a caller
 * could otherwise claim AI_SUGGESTED or forge `authoredBy`) and fills in what a human
 * editing a table shouldn't have to type: validFrom defaults to today, status to the caller's
 * intent (DRAFT for saveDraft, ACTIVE for saveActive and the legacy direct saves), the
 * routing-rules key to "*". Nested build-up rows that carry their own provenance keep it.
 */
function withHumanProvenance(kind, doc, req, status) {
  const provenance = { source: 'HUMAN', authoredBy: req.user.id, authoredAt: new Date().toISOString() };
  const stampNested = (items) => (Array.isArray(items) ? items.map((item) => ({ ...item, provenance: item.provenance || provenance })) : items);
  const out = {
    ...doc,
    status,
    validFrom: doc.validFrom || todayIso(),
    validTo: doc.validTo ?? null,
    supersedes: doc.supersedes ?? null,
    provenance: status === 'ACTIVE' ? { ...provenance, publishedBy: req.user.id, publishedAt: provenance.authoredAt } : provenance,
  };
  for (const field of NESTED_WITH_PROVENANCE) if (doc[field]) out[field] = stampNested(doc[field]);
  if (kind === 'routing-rules') out.key = '*';
  return out;
}

/** ConfigValidationError → 422 (or 404 when the store says NOT_FOUND) instead of a 500. */
async function trySave(req, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      if (Array.isArray(err.details) && err.details.includes('NOT_FOUND')) return req.reject(404, err.message);
      return req.reject(422, `${err.message}${err.details ? ' — ' + JSON.stringify(err.details) : ''}`);
    }
    throw err;
  }
}

function bookSummary(kind, key, doc) {
  const drafts = store.listVersions(kind, key).filter((v) => v.status === 'DRAFT').length;
  return {
    id: doc.id,
    name: doc.name,
    kind,
    version: doc.version,
    status: doc.status,
    currency: doc.currency,
    appliesWhen: doc.appliesWhen || {},
    validFrom: doc.validFrom,
    validTo: doc.validTo ?? null,
    rows: Array.isArray(doc.rows) ? doc.rows.length : 0,
    ...(kind === 'catalog-book' ? { fallbackFormula: doc.fallbackFormula || null, costInputs: Object.keys(doc.costInputs || {}) } : {}),
    drafts,
  };
}

module.exports = (srv) => {
  srv.before('*', requireUserPrincipal);

  // ---- generic reads ----------------------------------------------------------------------

  srv.on('getEffective', (req) => {
    const kind = requireKind(req, req.data.kind);
    const key = normalizeKey(kind, req.data.key);
    if (!key) return req.reject(400, 'key is required.');
    const doc = store.getEffective(kind, key, req.data.asOf || todayIso());
    if (!doc) return req.reject(404, `No effective ${kind} "${key}" as of ${req.data.asOf || todayIso()}.`);
    return doc;
  });

  srv.on('listVersions', (req) => {
    const { region, salesOrg } = req.data;
    if (!req.data.kind && region) return { versions: store.listVersions(region, salesOrg || '*') }; // legacy shape
    const kind = requireKind(req, req.data.kind);
    const key = normalizeKey(kind, req.data.key);
    if (!key) return req.reject(400, 'key is required.');
    return { kind, key, versions: store.listVersions(kind, key) };
  });

  srv.on('getVersion', (req) => {
    const kind = requireKind(req, req.data.kind);
    const key = normalizeKey(kind, req.data.key);
    if (!key || !req.data.version) return req.reject(400, 'key and version are required.');
    const doc = store.getVersion(kind, key, req.data.version);
    if (!doc) return req.reject(404, `No version "${req.data.version}" of ${kind} "${key}".`);
    return doc;
  });

  srv.on('diff', (req) => {
    const kind = requireKind(req, req.data.kind);
    const key = normalizeKey(kind, req.data.key);
    const { a, b } = req.data;
    if (!key || !a || !b) return req.reject(400, 'key, a and b are required.');
    const from = store.getVersion(kind, key, a);
    const to = store.getVersion(kind, key, b);
    if (!from) return req.reject(404, `No version "${a}" of ${kind} "${key}".`);
    if (!to) return req.reject(404, `No version "${b}" of ${kind} "${key}".`);
    // version/status/supersedes/provenance differ between any two versions by construction —
    // the interesting diff is the rules content.
    return { kind, key, a, b, changes: store.diff(from, to, { ignore: ['/version', '/status', '/supersedes', '/provenance'] }) };
  });

  srv.on('listBooks', (req) => {
    const kind = requireKind(req, req.data.kind);
    if (kind !== 'price-list' && kind !== 'catalog-book') return req.reject(400, 'listBooks takes kind price-list or catalog-book.');
    const asOf = req.data.asOf || todayIso();
    const books = store.listKeys(kind).map((key) => {
      const doc = store.getEffective(kind, key, asOf) || store.listVersions(kind, key).at(-1);
      return bookSummary(kind, key, doc);
    });
    return { kind, asOf, books };
  });

  srv.on('listKeys', (req) => {
    const kind = requireKind(req, req.data.kind);
    return { kind, keys: store.listKeys(kind) };
  });

  srv.on('listDrafts', (req) => {
    const kind = req.data.kind ? requireKind(req, req.data.kind) : undefined;
    return { drafts: store.listDrafts(kind) };
  });

  srv.on('listSuppliers', (req) => ({ suppliers: store.listSuppliers(req.data.asOf || todayIso()) }));

  /** Live formula check for the catalog sheet: engine-core's parser plus, when a book is
   *  named, the check that every cost.* the formula uses exists in that book's costInputs. */
  srv.on('validateFormula', (req) => {
    const { formula, kind, key, version } = req.data;
    if (!formula) return req.reject(400, 'formula is required.');
    let available = [];
    let book = null;
    if (kind && key) {
      const k = requireKind(req, kind);
      const docKey = normalizeKey(k, key);
      book = version ? store.getVersion(k, docKey, version) : store.getEffective(k, docKey, todayIso()) || store.listVersions(k, docKey).at(-1);
      if (!book) return req.reject(404, `No ${k} "${docKey}".`);
    }
    const parsed = validateFormula(formula);
    if (book) {
      available = Object.keys(book.costInputs || {}).map((n) => `cost.${n}`);
      const unknown = parsed.variables.filter((v) => v.startsWith('cost.') && !available.includes(v));
      return { ...parsed, ok: parsed.ok && unknown.length === 0, unknown, costInputs: available, book: book.id, bookVersion: book.version };
    }
    return { ...parsed, unknown: [], costInputs: available };
  });

  // ---- generic writes -----------------------------------------------------------------------

  srv.on('saveDraft', (req) => {
    const { kind: rawKind, doc } = req.data.payload || {};
    const kind = requireKind(req, rawKind);
    if (!doc || typeof doc !== 'object') return req.reject(400, 'payload.doc is required.');
    const prepared = withHumanProvenance(kind, doc, req, 'DRAFT');
    return trySave(req, async () => {
      const key = KINDS[kind].keyOf(prepared);
      if (!prepared.version) prepared.version = store.suggestVersion(kind, key);
      return store.save(kind, prepared);
    });
  });

  srv.on('publish', (req) => {
    const { kind: rawKind, key: rawKey, version, effectiveFrom, note } = req.data.payload || {};
    const kind = requireKind(req, rawKind);
    const key = normalizeKey(kind, rawKey);
    if (!key || !version) return req.reject(400, 'payload.key and payload.version are required.');
    return trySave(req, () => store.publish(kind, key, version, { effectiveFrom, publishedBy: req.user.id, note }));
  });

  srv.on('discardDraft', (req) => {
    const { kind: rawKind, key: rawKey, version } = req.data.payload || {};
    const kind = requireKind(req, rawKind);
    const key = normalizeKey(kind, rawKey);
    if (!key || !version) return req.reject(400, 'payload.key and payload.version are required.');
    return trySave(req, () => store.discard(kind, key, version));
  });

  /** Save + go live in one call (the pre-v2 direct-save behaviour; scripts and the Suppliers
   *  sheet). Accepts `{ kind, doc }`, or a legacy bare document with `kind` alongside it. */
  srv.on('saveActive', (req) => {
    const payload = req.data.payload || {};
    const doc = payload.doc || (({ kind, ...rest }) => rest)(payload);
    const kind = requireKind(req, payload.kind);
    if (!doc.version) return req.reject(400, 'payload.doc.version is required — an ACTIVE save is a new, named version.');
    return trySave(req, () => store.save(kind, withHumanProvenance(kind, doc, req, 'ACTIVE')));
  });

  // ---- AI suggestions (any kind) ------------------------------------------------------------

  srv.on('listSuggestions', (req) => {
    const { status, targetKind, targetKey, region } = req.data;
    return { suggestions: store.listSuggestions({ region, targetKind, targetKey: targetKind ? normalizeKey(targetKind, targetKey) : targetKey }, status) };
  });

  srv.on('suggestChange', async (req) => {
    const p = req.data.payload || {};
    const targetKind = p.targetKind || p.kind || (p.region ? 'region-config' : null);
    if (!targetKind || !p.instruction) return req.reject(400, 'payload.targetKind, payload.targetKey and payload.instruction are required.');
    const kind = requireKind(req, targetKind);
    const key = normalizeKey(kind, p.targetKey || p.key || (p.region ? `${p.region}::${p.salesOrg || '*'}` : null));
    if (!key) return req.reject(400, 'payload.targetKey is required.');

    const aiClient = getAiClientOrNull();
    if (!aiClient) {
      return {
        status: 'AI_NOT_CONFIGURED',
        message: 'ANTHROPIC_API_KEY is not set — the AI-suggestion pipeline is wired but has no live client. Set the key to enable this endpoint.',
      };
    }

    const currentConfig = p.version ? store.getVersion(kind, key, p.version) : store.getEffective(kind, key, todayIso());
    if (!currentConfig) return req.reject(404, `No ${kind} "${key}"${p.version ? ` version "${p.version}"` : ''}.`);

    const suggestion = await suggestConfigChange({ aiClient, kind, key, currentConfig, instruction: p.instruction, requestedBy: req.user.id });
    return store.saveSuggestion(suggestion);
  });

  /** Approval produces a DRAFT (four-eyes) — someone still has to publish. */
  srv.on('approveSuggestion', (req) => {
    const { suggestionId, newVersion } = req.data.payload || {};
    if (!suggestionId) return req.reject(400, 'payload.suggestionId is required.');
    const suggestion = store.getSuggestion(suggestionId);
    if (!suggestion) return req.reject(404, `Suggestion "${suggestionId}" not found.`);
    return trySave(req, () => applySuggestion(suggestion, { store, approvedBy: req.user.id, newVersion }));
  });

  srv.on('rejectSuggestion', (req) => {
    const { suggestionId, reviewNotes } = req.data.payload || {};
    if (!suggestionId) return req.reject(400, 'payload.suggestionId is required.');
    const suggestion = store.getSuggestion(suggestionId);
    if (!suggestion) return req.reject(404, `Suggestion "${suggestionId}" not found.`);
    return rejectSuggestion(suggestion, { reviewedBy: req.user.id, reviewNotes, store });
  });

  // ---- legacy aliases -----------------------------------------------------------------------

  const effectiveOr404 = (req, kind, key, label) => {
    const doc = store.getEffective(kind, key, req.data.asOf || todayIso());
    if (!doc) return req.reject(404, `No effective ${label}.`);
    return doc;
  };

  srv.on('getEffectiveConfig', (req) => {
    const { region, salesOrg = '*' } = req.data;
    if (!region) return req.reject(400, 'region is required.');
    return effectiveOr404(req, 'region-config', `${region}::${salesOrg}`, `config for region "${region}" / salesOrg "${salesOrg}"`);
  });

  srv.on('getEffectiveSupplierConfig', (req) => {
    if (!req.data.supplier) return req.reject(400, 'supplier is required.');
    return effectiveOr404(req, 'supplier-config', req.data.supplier, `supplier-config for supplier "${req.data.supplier}"`);
  });

  srv.on('listSupplierConfigVersions', (req) => {
    if (!req.data.supplier) return req.reject(400, 'supplier is required.');
    return { versions: store.listSupplierConfigVersions(req.data.supplier) };
  });

  srv.on('getEffectiveRegionRoute', (req) => {
    const { ood, salesOrg = '*' } = req.data;
    if (!ood) return req.reject(400, 'ood is required.');
    return effectiveOr404(req, 'region-route', `${ood}::${salesOrg}`, `region-route for ood "${ood}" / salesOrg "${salesOrg}"`);
  });

  srv.on('listRegionRouteVersions', (req) => {
    const { ood, salesOrg = '*' } = req.data;
    if (!ood) return req.reject(400, 'ood is required.');
    return { versions: store.listRegionRouteVersions(ood, salesOrg) };
  });

  srv.on('getEffectivePartyConfig', (req) => {
    if (!req.data.customerId) return req.reject(400, 'customerId is required.');
    return effectiveOr404(req, 'party-config', req.data.customerId, `party-config for customerId "${req.data.customerId}"`);
  });

  srv.on('listPartyConfigVersions', (req) => {
    if (!req.data.customerId) return req.reject(400, 'customerId is required.');
    return { versions: store.listPartyConfigVersions(req.data.customerId) };
  });

  const legacySave = (kind, required) => (req) => {
    const doc = req.data.payload || {};
    const missing = required.filter((f) => !doc[f]);
    if (missing.length) return req.reject(400, `${required.map((f) => `payload.${f}`).join(', ')} are required.`);
    return trySave(req, () => store.save(kind, withHumanProvenance(kind, doc, req, doc.status || 'ACTIVE')));
  };
  srv.on('saveRegionConfig', legacySave('region-config', ['region', 'salesOrg', 'version']));
  srv.on('saveSupplierConfig', legacySave('supplier-config', ['supplier', 'version']));
  srv.on('saveRegionRoute', legacySave('region-route', ['ood', 'salesOrg', 'region', 'version']));
  srv.on('savePartyConfig', legacySave('party-config', ['customerId', 'version']));
};
