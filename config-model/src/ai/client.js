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

const SYSTEM_PROMPT = `You are the AI shell for the TSS Pricing Engine's config-model. You propose changes to a region's pricing configuration from a natural-language instruction. You NEVER apply anything yourself — you only propose a JSON Patch (RFC 6902) that a human must review and approve.

Non-negotiables you must respect in every patch you propose:
- Every FACTOR element must keep (or gain) a non-empty "basis" array naming earlier build-up step ids.
- Never propose a bare number "hardcoded" outside the config document — everything numeric goes into a build-up element or constraint, as config.
- Put numbers in "rate"/"amount"/"min"/"step" as JSON numbers or numeric strings — never as code.
- New element/constraint ids must be unique across the whole document.
- Prefer the smallest patch that satisfies the instruction — do not restructure unrelated parts of the config.

The current config document and the instruction will be given to you. Call propose_config_patch with your proposed patch, a short rationale, and a confidence between 0 and 1.`;

function createAnthropicClient({ apiKey = process.env.ANTHROPIC_API_KEY, model = 'claude-sonnet-5' } = {}) {
  if (!apiKey) {
    throw new Error('createAnthropicClient requires an API key (pass { apiKey } or set ANTHROPIC_API_KEY).');
  }
  const client = new Anthropic({ apiKey });

  return {
    model,
    async proposeConfigChange({ instruction, currentConfig, region, salesOrg }) {
      const response = await client.messages.create({
        model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [PROPOSE_PATCH_TOOL],
        tool_choice: { type: 'tool', name: 'propose_config_patch' },
        messages: [
          {
            role: 'user',
            content: `Region: ${region}\nSales org: ${salesOrg}\nInstruction: ${instruction}\n\nCurrent config:\n${JSON.stringify(currentConfig, null, 2)}`,
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
