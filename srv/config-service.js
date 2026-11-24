const { suggestConfigChange, applySuggestion, rejectSuggestion, ConfigValidationError } = require('@tss-pricing/config-model');
const { store } = require('./lib/store');
const { api6 } = require('./lib/api6');
const { currentC4c } = require('./lib/c4c');
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
    const { supplier, asOf } = req.data;
    if (!supplier) return req.reject(400, 'supplier is required.');
    const config = store.getEffectiveSupplierConfig(supplier, asOf || todayIso());
    if (!config) return req.reject(404, `No effective supplier-config for supplier "${supplier}".`);
    return config;
  });

  srv.on('listSuppliers', (req) => {
    const { asOf } = req.data;
    return { suppliers: store.listSuppliers(asOf || todayIso()) };
  });

  srv.on('listSupplierConfigVersions', (req) => {
    const { supplier } = req.data;
    if (!supplier) return req.reject(400, 'supplier is required.');
    return { versions: store.listSupplierConfigVersions(supplier) };
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

  srv.on('getConnections', async () => {
    const c4cInfo = await currentC4c().describe();
    const conn = store.getEffectiveConnectionConfig(todayIso());
    return {
      // Effective values = UI-saved connection-config (when one exists) over environment
      // defaults — exactly what the adapters use on the next call.
      configVersion: conn ? conn.version : null,
      api6: {
        mode: api6.mode, // 'recorded' (dev fixtures, no outbound calls) or 'live'
        authType: api6.authType,
        baseUrl: (conn && conn.api6 && conn.api6.baseUrl) || process.env.API6_BASE_URL || null,
        costSourceEndpoints: api6.costSourceEndpoints,
        priceListEndpoint: api6.priceListEndpoint,
        maintainedVia: 'Editable here (saved as a versioned connection-config). Environment defaults: API6_MODE, API6_BASE_URL. Credentials/auth stay environment-owned. The cost source ORDER stays pricing config (Cost Rules tab).',
      },
      c4c: {
        destinationName: c4cInfo.destinationName,
        configured: c4cInfo.configured,
        url: c4cInfo.url,
        servicePath: c4cInfo.servicePath,
        fieldMap: c4cInfo.fieldMap,
        maintainedVia: 'Service path and field map editable here. The destination itself (URL + technical user) stays in the BTP destination C4C_ODATA / environment — credentials are never stored in config.',
      },
      ai: {
        configured: !!getAiClientOrNull(),
        maintainedVia: 'Environment: ANTHROPIC_API_KEY.',
      },
    };
  });

  /**
   * Saves the integration endpoints as a new version of the global connection-config
   * (owner decision 2026-11-24: WSO2/API6 endpoints are external, not BTP-managed, so
   * admins maintain them here). Same rules as every config save: brand-new version, never
   * in place, server-stamped provenance, validation failure = 422 and an untouched store.
   * NO credentials: the schema rejects anything but endpoints/paths/field names, and a
   * live mode without a base URL is refused outright. Like all config, in-memory until
   * real persistence lands — a backend restart reverts to environment defaults.
   */
  srv.on('saveConnections', (req) => {
    const p = req.data.payload || {};
    const existing = store.getEffectiveConnectionConfig(todayIso());
    const versions = store.listConnectionConfigVersions();
    const doc = withHumanProvenance({
      name: 'GLOBAL',
      version: (p.version && String(p.version).trim()) || `${todayIso()}-r${versions.length + 1}`,
      api6: p.api6 || (existing && existing.api6) || {},
      c4c: p.c4c || (existing && existing.c4c) || {},
    }, req);
    return trySave(req, () => store.saveConnectionConfig(doc));
  });

  srv.on('lookupPriceList', async (req) => {
    const { region, supplier, productCategory, partNumber, quantity, asOf } = req.data;
    if (!region || !partNumber) return req.reject(400, 'region and partNumber are required.');
    if (!supplier && !productCategory) return req.reject(400, 'Provide a supplier or a productCategory to look up.');
    const result = await api6.fetchPriceListCost({
      region,
      partNumber,
      supplier: supplier || undefined,
      productCategory: productCategory || undefined,
      quantity: quantity || '1',
      priceDate: asOf || todayIso(),
    });
    return result;
  });

  srv.on('saveRegionConfig', (req) => {
    const doc = req.data.payload || {};
    if (!doc.region || !doc.salesOrg || !doc.version) return req.reject(400, 'payload.region, payload.salesOrg, and payload.version are required.');
    return trySave(req, () => store.saveVersion(withHumanProvenance(doc, req)));
  });

  srv.on('saveSupplierConfig', (req) => {
    const doc = req.data.payload || {};
    if (!doc.supplier || !doc.version) {
      return req.reject(400, 'payload.supplier and payload.version are required.');
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
