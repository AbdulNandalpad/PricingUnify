const crypto = require('node:crypto');

/**
 * Turns a natural-language instruction into a PENDING_REVIEW AiSuggestion — never a live
 * config change. The instruction and the AI's raw proposal are recorded verbatim; nothing
 * here writes to the config store.
 */
async function suggestConfigChange({ aiClient, region, salesOrg, currentConfig, instruction, requestedBy }) {
  if (currentConfig.region !== region) {
    throw new Error(`currentConfig is for region "${currentConfig.region}", not "${region}".`);
  }
  if (currentConfig.salesOrg !== salesOrg) {
    throw new Error(`currentConfig is for salesOrg "${currentConfig.salesOrg}", not "${salesOrg}".`);
  }

  const { patch, rationale, confidence } = await aiClient.proposeConfigChange({ instruction, currentConfig, region, salesOrg });

  return {
    id: crypto.randomUUID(),
    region,
    salesOrg,
    baseVersion: currentConfig.version,
    instruction,
    requestedBy,
    proposedPatch: patch,
    rationale,
    confidence,
    aiModel: aiClient.model,
    createdAt: new Date().toISOString(),
    status: 'PENDING_REVIEW',
  };
}

module.exports = { suggestConfigChange };
