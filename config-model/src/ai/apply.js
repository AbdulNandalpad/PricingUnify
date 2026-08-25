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
    throw new Error(`Suggestion "${suggestion.id}" is ${suggestion.status}, not PENDING_REVIEW.`);
  }
  if (!approvedBy) {
    throw new Error('applySuggestion requires an approvedBy — AI suggestions never go live unattended.');
  }

  const baseConfig = store.getVersion(suggestion.region, suggestion.baseVersion);
  if (!baseConfig) {
    throw new Error(`Base version "${suggestion.baseVersion}" for region "${suggestion.region}" not found.`);
  }

  const { newDocument } = jsonpatch.applyPatch(baseConfig, suggestion.proposedPatch, true, false);

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
    throw new Error(`Suggestion "${suggestion.id}" is ${suggestion.status}, not PENDING_REVIEW.`);
  }
  suggestion.status = 'REJECTED';
  suggestion.reviewedBy = reviewedBy;
  suggestion.reviewedAt = new Date().toISOString();
  suggestion.reviewNotes = reviewNotes;
  return suggestion;
}

module.exports = { applySuggestion, rejectSuggestion };
