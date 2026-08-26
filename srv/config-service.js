const { suggestConfigChange, applySuggestion, rejectSuggestion, ConfigValidationError } = require('@tss-pricing/config-model');
const { store } = require('./lib/store');
const { getAiClientOrNull } = require('./lib/ai');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Stamps every direct human edit's provenance server-side (never trusted from the payload —
 * a caller could otherwise claim AI_SUGGESTED or forge `authoredBy`) and fills in the fields
 * a human editing a table shouldn't have to type by hand: validFrom defaults to today, status
 * defaults to ACTIVE (a save goes live immediately, same precedent as an approved AI
 * suggestion — there's no separate DRAFT-then-activate step today). `version` is the one
 * field a human must still choose explicitly, same as approveSuggestion's `newVersion`.
 *
 * build-up-element/constraint/resolution-rule each require their own `provenance` too (same
 * non-negotiable as the document itself) — a human editing one table row shouldn't have to
 * type provenance JSON for every row, so any nested item missing one gets the same stamp.
 */
function withHumanProvenance(doc, req) {
  const authoredAt = new Date().toISOString();
  const provenance = { source: 'HUMAN', authoredBy: req.user.id, authoredAt };
  const stampNested = (items) => (Array.isArray(items) ? items.map((item) => ({ ...item, provenance: item.provenance || provenance })) : items);
  return {
    ...doc,
    status: doc.status || 'ACTIVE',
    validFrom: doc.validFrom || todayIso(),
    validTo: doc.validTo ?? null,
    ...(doc.buildUp ? { buildUp: stampNested(doc.buildUp) } : {}),
    ...(doc.constraints ? { constraints: stampNested(doc.constraints) } : {}),
    ...(doc.resolution ? { resolution: stampNested(doc.resolution) } : {}),
    provenance,
  };
}

/** Every direct-save handler shares this shape: validate via the store's own saveXxx (which
 *  re-checks schema + business rules, e.g. the FACTOR-basis rule, same as approveSuggestion),
 *  and turn a ConfigValidationError into a clear 422 instead of a generic 500. */
function trySave(req, saveFn) {
  try {
    return saveFn();
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      return req.reject(422, `${err.message}${err.details ? ' — ' + JSON.stringify(err.details) : ''}`);
    }
    throw err;
  }
}

module.exports = (srv) => {
  srv.on('getEffectiveConfig', (req) => {
    const { region, salesOrg = '*', asOf } = req.data;
    if (!region) return req.reject(400, 'region is required.');
    const config = store.getEffectiveAsOf(region, salesOrg, asOf || todayIso());
    if (!config) return req.reject(404, `No effective config for region "${region}" / salesOrg "${salesOrg}".`);
    return config;
  });

  srv.on('listVersions', (req) => {
    const { region, salesOrg = '*' } = req.data;
    if (!region) return req.reject(400, 'region is required.');
    return { versions: store.listVersions(region, salesOrg) };
  });

  srv.on('listSuggestions', (req) => {
    const { region, status } = req.data;
    return { suggestions: store.listSuggestions(region, status) };
  });

  srv.on('getEffectiveSupplierConfig', (req) => {
    const { region, salesOrg = '*', supplier, asOf } = req.data;
    if (!region || !supplier) return req.reject(400, 'region and supplier are required.');
    const config = store.getEffectiveSupplierConfig(region, salesOrg, supplier, asOf || todayIso());
    if (!config) return req.reject(404, `No effective supplier-config for region "${region}" / salesOrg "${salesOrg}" / supplier "${supplier}".`);
    return config;
  });

  srv.on('listSuppliers', (req) => {
    const { region, salesOrg = '*', asOf } = req.data;
    if (!region) return req.reject(400, 'region is required.');
    return { suppliers: store.listSuppliers(region, salesOrg, asOf || todayIso()) };
  });

  srv.on('getEffectiveRegionRoute', (req) => {
    const { ood, salesOrg = '*', asOf } = req.data;
    if (!ood) return req.reject(400, 'ood is required.');
    const route = store.getEffectiveRegionRoute(ood, salesOrg, asOf || todayIso());
    if (!route) return req.reject(404, `No effective region-route for ood "${ood}" / salesOrg "${salesOrg}".`);
    return route;
  });

  srv.on('listRegionRouteVersions', (req) => {
    const { ood, salesOrg = '*' } = req.data;
    if (!ood) return req.reject(400, 'ood is required.');
    return { versions: store.listRegionRouteVersions(ood, salesOrg) };
  });

  srv.on('getEffectivePartyConfig', (req) => {
    const { customerId, asOf } = req.data;
    if (!customerId) return req.reject(400, 'customerId is required.');
    const config = store.getEffectivePartyConfig(customerId, asOf || todayIso());
    if (!config) return req.reject(404, `No effective party-config for customerId "${customerId}".`);
    return config;
  });

  srv.on('listPartyConfigVersions', (req) => {
    const { customerId } = req.data;
    if (!customerId) return req.reject(400, 'customerId is required.');
    return { versions: store.listPartyConfigVersions(customerId) };
  });

  srv.on('saveRegionConfig', (req) => {
    const doc = req.data.payload || {};
    if (!doc.region || !doc.salesOrg || !doc.version) return req.reject(400, 'payload.region, payload.salesOrg, and payload.version are required.');
    return trySave(req, () => store.saveVersion(withHumanProvenance(doc, req)));
  });

  srv.on('saveSupplierConfig', (req) => {
    const doc = req.data.payload || {};
    if (!doc.region || !doc.salesOrg || !doc.supplier || !doc.version) {
      return req.reject(400, 'payload.region, payload.salesOrg, payload.supplier, and payload.version are required.');
    }
    return trySave(req, () => store.saveSupplierConfig(withHumanProvenance(doc, req)));
  });

  srv.on('saveRegionRoute', (req) => {
    const doc = req.data.payload || {};
    if (!doc.ood || !doc.salesOrg || !doc.region || !doc.version) {
      return req.reject(400, 'payload.ood, payload.salesOrg, payload.region, and payload.version are required.');
    }
    return trySave(req, () => store.saveRegionRoute(withHumanProvenance(doc, req)));
  });

  srv.on('savePartyConfig', (req) => {
    const doc = req.data.payload || {};
    if (!doc.customerId || !doc.version) return req.reject(400, 'payload.customerId and payload.version are required.');
    return trySave(req, () => store.savePartyConfig(withHumanProvenance(doc, req)));
  });

  srv.on('suggestChange', async (req) => {
    const { region, salesOrg = '*', version, instruction } = req.data.payload || {};
    if (!region || !instruction) return req.reject(400, 'payload.region and payload.instruction are required.');

    const aiClient = getAiClientOrNull();
    if (!aiClient) {
      return {
        status: 'AI_NOT_CONFIGURED',
        message: 'ANTHROPIC_API_KEY is not set — the AI-suggestion pipeline is wired but has no live client. Set the key to enable this endpoint.',
      };
    }

    const currentConfig = version
      ? store.getVersion(region, salesOrg, version)
      : store.getEffectiveAsOf(region, salesOrg, todayIso());
    if (!currentConfig) return req.reject(404, `No config found for region "${region}" / salesOrg "${salesOrg}".`);

    const suggestion = await suggestConfigChange({
      aiClient,
      region,
      salesOrg,
      currentConfig,
      instruction,
      requestedBy: req.user.id,
    });
    return store.saveSuggestion(suggestion);
  });

  srv.on('approveSuggestion', (req) => {
    const { suggestionId, newVersion } = req.data.payload || {};
    if (!suggestionId || !newVersion) return req.reject(400, 'payload.suggestionId and payload.newVersion are required.');
    const suggestion = store.getSuggestion(suggestionId);
    if (!suggestion) return req.reject(404, `Suggestion "${suggestionId}" not found.`);
    return applySuggestion(suggestion, { store, approvedBy: req.user.id, newVersion });
  });

  srv.on('rejectSuggestion', (req) => {
    const { suggestionId, reviewNotes } = req.data.payload || {};
    if (!suggestionId) return req.reject(400, 'payload.suggestionId is required.');
    const suggestion = store.getSuggestion(suggestionId);
    if (!suggestion) return req.reject(404, `Suggestion "${suggestionId}" not found.`);
    return rejectSuggestion(suggestion, { reviewedBy: req.user.id, reviewNotes });
  });
};
