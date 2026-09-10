const crypto = require('node:crypto');
const { docKeyOf, isKind } = require('../kinds');

/**
 * Turns a natural-language instruction into a PENDING_REVIEW AiSuggestion against one
 * config document of any kind — never a live config change. The instruction and the AI's
 * raw proposal are recorded verbatim; nothing here writes to the config store.
 *
 * Target selection: `{ kind, key }` (v2), or the legacy `{ region, salesOrg }` pair, which
 * means kind 'region-config' / key `region::salesOrg`. `currentConfig` must be the document
 * at that key — a mismatch is refused rather than patched onto the wrong document.
 */
async function suggestConfigChange({ aiClient, kind, key, region, salesOrg, currentConfig, instruction, requestedBy }) {
  const targetKind = kind || 'region-config';
  if (!isKind(targetKind)) throw new Error(`Unknown config document kind "${targetKind}".`);
  const targetKey = key || (targetKind === 'region-config' && region ? `${region}::${salesOrg}` : null);
  if (!targetKey) throw new Error('suggestConfigChange requires { kind, key } (or region + salesOrg for a region config).');

  if (targetKind === 'region-config') {
    const [r, s] = targetKey.split('::');
    if (currentConfig.region !== r) throw new Error(`currentConfig is for region "${currentConfig.region}", not "${r}".`);
    if (currentConfig.salesOrg !== s) throw new Error(`currentConfig is for salesOrg "${currentConfig.salesOrg}", not "${s}".`);
  } else if (docKeyOf(targetKind, currentConfig) !== targetKey) {
    throw new Error(`currentConfig is ${targetKind} "${docKeyOf(targetKind, currentConfig)}", not "${targetKey}".`);
  }

  const { patch, rationale, confidence } = await aiClient.proposeConfigChange({ instruction, currentConfig, kind: targetKind, key: targetKey, region, salesOrg });

  const suggestion = {
    id: crypto.randomUUID(),
    targetKind,
    targetKey,
    baseVersion: currentConfig.version,
    instruction,
    proposedPatch: patch,
    rationale,
    confidence,
    aiModel: aiClient.model,
    createdAt: new Date().toISOString(),
    status: 'PENDING_REVIEW',
  };
  if (requestedBy) suggestion.requestedBy = requestedBy;
  if (targetKind === 'region-config') {
    suggestion.region = currentConfig.region;
    suggestion.salesOrg = currentConfig.salesOrg;
  }
  return suggestion;
}

module.exports = { suggestConfigChange };
