const jsonpatch = require('fast-json-patch');
const { validateRegionConfig, ConfigValidationError } = require('../validate');

/**
 * Applies an approved AiSuggestion: patches the base config, stamps AI provenance +
 * the human approval, re-validates against every non-negotiable (schema + FACTOR-basis
 * rule — the same checks the kernel itself relies on), and saves it as a new version.
 * Throws — and leaves the store untouched — if the AI's patch would produce an invalid
 * config; the suggestion stays PENDING_REVIEW so a human can see exactly what failed.
 */
function applySuggestion(suggestion, { store, approvedBy, newVersion }) {
  if (suggestion.status !== 'PENDING_REVIEW') {
    throw new ConfigValidationError(`Suggestion "${suggestion.id}" is ${suggestion.status}, not PENDING_REVIEW.`);
  }
  if (!approvedBy) {
    throw new ConfigValidationError('applySuggestion requires an approvedBy — AI suggestions never go live unattended.');
  }

  const baseConfig = store.getVersion(suggestion.region, suggestion.salesOrg, suggestion.baseVersion);
  if (!baseConfig) {
    throw new ConfigValidationError(
      `Base version "${suggestion.baseVersion}" for region "${suggestion.region}" / salesOrg "${suggestion.salesOrg}" not found.`,
    );
  }
  // The patch was written against THIS version. If a later version has superseded it since, applying
  // the patch to the old text would silently revert every change made in between — refuse, and ask for a fresh suggestion.
  if (baseConfig.status !== 'ACTIVE') {
    throw new ConfigValidationError(
      `AI suggestion "${suggestion.id}" is based on version "${baseConfig.version}", which is ${baseConfig.status} — a newer version exists. Request a new suggestion against the current version.`,
    );
  }

  let newDocument;
  try {
    ({ newDocument } = jsonpatch.applyPatch(baseConfig, suggestion.proposedPatch, true, false));
  } catch (err) {
    // A malformed or inapplicable patch is a problem with the SUGGESTION, not a server fault.
    throw new ConfigValidationError(`AI suggestion "${suggestion.id}" has a patch that cannot be applied: ${err.message}`);
  }
  // A suggestion edits the CONTENT of a config; it can never move it to another (region, salesOrg) —
  // that would save under a different key than the one a human reviewed.
  if (newDocument.region !== baseConfig.region || newDocument.salesOrg !== baseConfig.salesOrg) {
    throw new ConfigValidationError(
      `AI suggestion "${suggestion.id}" tries to change the config's region/salesOrg (${baseConfig.region}/${baseConfig.salesOrg}) — not applied.`,
    );
  }

  const now = new Date().toISOString();
  newDocument.version = newVersion;
  newDocument.status = 'ACTIVE';
  newDocument.supersedes = baseConfig.version;
  newDocument.provenance = {
    source: 'AI_SUGGESTED',
    authoredBy: `ai:${suggestion.aiModel}`,
    authoredAt: suggestion.createdAt,
    aiModel: suggestion.aiModel,
    aiConfidence: suggestion.confidence,
    aiRationale: suggestion.rationale,
    approvedBy,
    approvedAt: now,
  };

  try {
    validateRegionConfig(newDocument);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      throw new ConfigValidationError(
        `AI suggestion "${suggestion.id}" would produce an invalid config — not applied: ${err.message}`,
        err.details,
      );
    }
    throw err;
  }

  store.saveVersion(newDocument);
  suggestion.status = 'APPLIED';
  suggestion.reviewedBy = approvedBy;
  suggestion.reviewedAt = now;
  suggestion.resultingVersion = newVersion;

  return newDocument;
}

function rejectSuggestion(suggestion, { reviewedBy, reviewNotes }) {
  if (suggestion.status !== 'PENDING_REVIEW') {
    throw new ConfigValidationError(`Suggestion "${suggestion.id}" is ${suggestion.status}, not PENDING_REVIEW.`);
  }
  suggestion.status = 'REJECTED';
  suggestion.reviewedBy = reviewedBy;
  suggestion.reviewedAt = new Date().toISOString();
  suggestion.reviewNotes = reviewNotes;
  return suggestion;
}

module.exports = { applySuggestion, rejectSuggestion };
