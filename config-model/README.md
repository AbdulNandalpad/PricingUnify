# config-model

Region config schemas, validation, effective-dated versioning — and the AI-suggestion
pipeline that turns a natural-language pricing instruction into a config change a human
must approve before it goes live.

## Tables (JSON Schemas in `schemas/`)

| Table | Purpose |
|---|---|
| `region-config` | One region = one versioned, effective-dated document: `region`, `version`, `status` (DRAFT/ACTIVE/SUPERSEDED/REJECTED), `validFrom`/`validTo`, `resolution[]`, `buildUp[]`, `constraints[]`, `rounding`, `fx`, `provenance`. |
| `build-up-element` | One line of `buildUp[]` — BASE, FACTOR (basis required), ADDER, or PER_LINE. Matches engine-core's primitives exactly. |
| `constraint` | One line of `constraints[]` — FLOOR or STEP (MOLV, MOV, SPU rounding). Applied by the kernel after the build-up, not within it. |
| `resolution-rule` | One step of the cost-resolution ladder (stock class → origin of data → supplier/COO/OOD → cost basis → fallback chain). Deliberately loose — the four regions in the concept deck have four different ladders behind the same five primitives. |
| `ai-suggestion` | A natural-language instruction, the AI's proposed JSON Patch against a region config, its rationale/confidence, and its full human review trail (PENDING_REVIEW → APPROVED/REJECTED → APPLIED). |
| `provenance` | Not a table of its own — embedded on every entity above. `{ source: HUMAN\|AI_SUGGESTED\|AI_DERIVED\|IMPORTED, authoredBy, authoredAt, aiModel?, aiConfidence?, aiRationale?, approvedBy?, approvedAt? }`. This is what makes every table AI-ready from scratch: any value can show it came from a human or from an AI proposal, with a confidence and a rationale, and — if AI-sourced — who approved it. |

There is no separate "config version history" table: every `region-config` document a region has ever had stays in the store (`ConfigStore`), so `getEffectiveAsOf(region, date)` can reprice a historical quote exactly at the rules that were live on that date (requirements §5.4), and the version list itself *is* the history.

## The AI pipeline

```
instruction (natural language)
   │
   ▼
suggestConfigChange()  ──calls──►  AI client (Anthropic, tool-forced JSON Patch output)
   │
   ▼
AiSuggestion { proposedPatch, rationale, confidence, status: PENDING_REVIEW }
   │
   ├── rejectSuggestion()  → status: REJECTED, store untouched
   │
   └── applySuggestion({ approvedBy })
          │  re-validates the patched document against every non-negotiable
          │  (schema + "every FACTOR needs a basis" + no duplicate ids, ...)
          │  — throws and leaves the store untouched if the AI's patch is invalid
          ▼
   new region-config version, status: ACTIVE, provenance.source: AI_SUGGESTED
```

The AI never writes to the store directly — `suggestConfigChange()` only returns a
suggestion. Applying one is a separate, explicit call that requires `approvedBy` and
re-runs full validation, exactly matching design principle #2: *"Deterministic core, AI
shell... AI suggests and explains around the core; it never silently prices."*

`createFakeClient()` gives tests a canned AI response with no network call — config-model
does I/O in production (unlike `engine-core`, which never does), but its own tests stay
hermetic. `createAnthropicClient()` is the real thing; it reads `ANTHROPIC_API_KEY` from
the environment (wired as a BTP destination/service credential once `srv/` exists).

## Usage

```js
const { ConfigStore, createFakeClient, suggestConfigChange, applySuggestion } = require('@tss-pricing/config-model');

const store = new ConfigStore();
store.saveVersion(myEuropeConfigV1);

const suggestion = await suggestConfigChange({
  aiClient: createFakeClient({ patch: [...], rationale: '...', confidence: 0.9 }),
  region: 'EUROPE',
  currentConfig: store.getVersion('EUROPE', '2026.08.0'),
  instruction: 'Add a 3% tariff surcharge for parts sourced from China.',
  requestedBy: 'pricing-lead@tss.example',
});

// ... a human reviews suggestion.proposedPatch / rationale / confidence ...

applySuggestion(suggestion, { store, approvedBy: 'head-of-pricing@tss.example', newVersion: '2026.08.1' });
```
