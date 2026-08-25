const { suggestConfigChange, applySuggestion, rejectSuggestion } = require('@tss-pricing/config-model');
const { store } = require('./lib/store');
const { getAiClientOrNull } = require('./lib/ai');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
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
