/** Kernel: applies a region config (build-up of typed elements) to resolved facts.
 *  Signature: price({ request, facts, config }) -> { items: [{ status, result?, missing?, trace }] }
 *  TODO Phase 1: implement 5 primitives + constraints + trace. */
function price(input) {
  throw new Error('Not implemented — Phase 1. See docs/PRICING_ENGINE_REQUIREMENTS.md §5');
}
module.exports = { price };
