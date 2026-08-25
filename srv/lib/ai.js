const { createAnthropicClient } = require('@tss-pricing/config-model');

/** null until ANTHROPIC_API_KEY is set — the AI-suggestion endpoint reports that clearly
 *  rather than ever faking a response outside of tests (config-model's own tests use
 *  createFakeClient() instead; that's a test-only concern, not something a live API path
 *  should do). */
function getAiClientOrNull() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return createAnthropicClient();
}

module.exports = { getAiClientOrNull };
