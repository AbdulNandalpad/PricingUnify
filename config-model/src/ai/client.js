/** AI client for turning a natural-language pricing instruction into a proposed config
 *  change. Two implementations behind the same interface:
 *   - createAnthropicClient(): the real thing, calls the Claude API.
 *   - createFakeClient(response): a canned response for tests — config-model's own
 *     tests must stay hermetic (no network, no API key), even though config-model
 *     (unlike engine-core) is allowed to do I/O. */
const Anthropic = require('@anthropic-ai/sdk');

const PROPOSE_PATCH_TOOL = {
  name: 'propose_config_patch',
  description:
    "Propose a JSON Patch (RFC 6902) against the current region pricing config that implements the user's natural-language instruction, plus a rationale and a confidence score.",
  input_schema: {
    type: 'object',
    required: ['patch', 'rationale', 'confidence'],
    properties: {
      patch: {
        type: 'array',
        items: {
          type: 'object',
          required: ['op', 'path'],
          properties: {
            op: { enum: ['add', 'remove', 'replace', 'move', 'copy', 'test'] },
            path: { type: 'string' },
            from: { type: 'string' },
            value: {},
          },
        },
      },
      rationale: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
};

const SYSTEM_PROMPT = `You are the AI shell for the TSS Pricing Engine's config-model. You propose changes to ONE pricing configuration document — a region's landed-cost build-up (region-config), a price list, a catalog + formula book, the technique routing rules, a supplier or a customer record — from a natural-language instruction. You NEVER apply anything yourself — you only propose a JSON Patch (RFC 6902) that a human must review, approve (which produces a DRAFT) and then publish.

Non-negotiables you must respect in every patch you propose:
- region-config: every FACTOR element must keep (or gain) a non-empty "basis" array naming earlier build-up step ids; a "sell.defaultMargin" is a fraction in [0, 1).
- price-list: every row "match" key must be a declared dimension; tiers start at quantity 0 and strictly increase; never two rows for the same part with the same match and overlapping validity.
- catalog-book: rows are unique on the book's matchOn attributes; "fallbackFormula" is formula DSL v1 (numbers, identifiers, + - * / ^, parentheses, min/max/round/abs) and every "cost.<name>" it uses must exist in "costInputs".
- routing-rules: every rule points at an existing book of the stated type.
- Never propose a bare number "hardcoded" outside the config document — everything numeric goes into the document, as config.
- Put numbers as JSON numbers or numeric strings — never as code.
- Never change the document's identity fields (region, salesOrg, supplier, ood, customerId, id, key) or its version/status/provenance — the store manages those.
- Prefer the smallest patch that satisfies the instruction — do not restructure unrelated parts of the document.

The document kind, its key, the current document and the instruction will be given to you. Call propose_config_patch with your proposed patch, a short rationale, and a confidence between 0 and 1.`;

function createAnthropicClient({ apiKey = process.env.ANTHROPIC_API_KEY, model = 'claude-sonnet-5' } = {}) {
  if (!apiKey) {
    throw new Error('createAnthropicClient requires an API key (pass { apiKey } or set ANTHROPIC_API_KEY).');
  }
  const client = new Anthropic({ apiKey });

  return {
    model,
    async proposeConfigChange({ instruction, currentConfig, kind = 'region-config', key, region, salesOrg }) {
      const target = key || `${region}::${salesOrg}`;
      const response = await client.messages.create({
        model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [PROPOSE_PATCH_TOOL],
        tool_choice: { type: 'tool', name: 'propose_config_patch' },
        messages: [
          {
            role: 'user',
            content: `Document kind: ${kind}\nDocument key: ${target}\nInstruction: ${instruction}\n\nCurrent document:\n${JSON.stringify(currentConfig, null, 2)}`,
          },
        ],
      });
      const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === 'propose_config_patch');
      if (!toolUse) {
        throw new Error('AI did not return a propose_config_patch tool call.');
      }
      return { patch: toolUse.input.patch, rationale: toolUse.input.rationale, confidence: toolUse.input.confidence };
    },
  };
}

function createFakeClient(response) {
  return {
    model: 'fake-client',
    async proposeConfigChange() {
      return typeof response === 'function' ? response() : response;
    },
  };
}

module.exports = { createAnthropicClient, createFakeClient };
