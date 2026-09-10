const jsonpatch = require('fast-json-patch');
const { validateDocument, ConfigValidationError } = require('../validate');
const { docKeyOf } = require('../kinds');

function targetOf(suggestion) {
  const kind = suggestion.targetKind || 'region-config';
  const key = suggestion.targetKey || `${suggestion.region}::${suggestion.salesOrg}`;
  return { kind, key };
}

/**
 * Applies an approved AiSuggestion: patches the base document, stamps AI provenance + the
 * human approval, re-validates against every non-negotiable of that document kind (schema +
 * business rules — the same checks the kernel itself relies on), and saves it as a new
 * **DRAFT** version (ARCHITECTURE_V2 §4.3, four-eyes: approving is not publishing — someone
 * still has to call publish). Throws — and leaves the store untouched — if the AI's patch
 * would produce an invalid document; the suggestion stays PENDING_REVIEW so a human can see
 * exactly what failed.
 */
function applySuggestion(suggestion, { store, approvedBy, newVersion }) {
  if (suggestion.status !== 'PENDING_REVIEW') {
    throw new Error(`Suggestion "${suggestion.id}" is ${suggestion.status}, not PENDING_REVIEW.`);
  }
  if (!approvedBy) {
    throw new Error('applySuggestion requires an approvedBy — AI suggestions never go live unattended.');
  }

  const { kind, key } = targetOf(suggestion);
  const baseConfig = store.getVersion(kind, key, suggestion.baseVersion);
  if (!baseConfig) {
    throw new Error(`Base version "${suggestion.baseVersion}" of ${kind} "${key}" not found.`);
  }

  const { newDocument } = jsonpatch.applyPatch(baseConfig, suggestion.proposedPatch, true, false);
  if (docKeyOf(kind, newDocument) !== key) {
    throw new ConfigValidationError(`AI suggestion "${suggestion.id}" would move the document to another key — not applied.`);
  }

  const now = new Date().toISOString();
  newDocument.version = newVersion || store.suggestVersion(kind, key);
  newDocument.status = 'DRAFT';
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
    validateDocument(kind, newDocument);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      throw new ConfigValidationError(
        `AI suggestion "${suggestion.id}" would produce an invalid ${kind} — not applied: ${err.message}`,
        err.details,
      );
    }
    throw err;
  }

  store.saveSync(kind, newDocument);
  suggestion.status = 'APPLIED';
  suggestion.reviewedBy = approvedBy;
  suggestion.reviewedAt = now;
  suggestion.resultingVersion = newDocument.version;
  if (typeof store.updateSuggestion === 'function' && store.getSuggestion(suggestion.id)) store.updateSuggestion(suggestion);

  return newDocument;
}

function rejectSuggestion(suggestion, { reviewedBy, reviewNotes, store }) {
  if (suggestion.status !== 'PENDING_REVIEW') {
    throw new Error(`Suggestion "${suggestion.id}" is ${suggestion.status}, not PENDING_REVIEW.`);
  }
  suggestion.status = 'REJECTED';
  suggestion.reviewedBy = reviewedBy;
  suggestion.reviewedAt = new Date().toISOString();
  suggestion.reviewNotes = reviewNotes;
  if (store && typeof store.updateSuggestion === 'function' && store.getSuggestion(suggestion.id)) store.updateSuggestion(suggestion);
  return suggestion;
}

module.exports = { applySuggestion, rejectSuggestion, targetOf };
