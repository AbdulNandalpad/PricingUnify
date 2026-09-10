'use strict';

/**
 * Pure tool definitions: { name, description, inputSchema (zod raw shape), handler }.
 * Handlers only ever go through the injected client, so the whole set is unit-testable
 * with a fake fetch. None of them publishes or saves config — going live is a human
 * action in the app (ARCHITECTURE_V2 §5).
 */

const { z } = require('zod');

const PRICING = '/rest/pricing';
const CONFIG = '/rest/config';

const RULE_KINDS = ['region-config', 'price-list', 'catalog-book', 'routing-rules'];
const BOOK_KINDS = ['price-list', 'catalog-book'];
const TECHNIQUES = ['COST_PLUS', 'PRICE_LIST', 'CATALOG_FORMULA'];
const PURPOSES = ['INDICATIVE', 'BINDING', 'REPRICE'];

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const itemSchema = z.object({
  partNumber: z.string().min(1).describe('Part / material number as the customer or ERP knows it.'),
  quantity: z.number().positive().describe('Order quantity for this line.'),
  pricingType: z.enum(TECHNIQUES).optional()
    .describe('Force a technique instead of letting routing rules decide (routedBy becomes USER).'),
  book: z.string().optional().describe('Price list or catalog id to use when pricingType is forced.'),
  supplier: z.string().optional(),
  supplierCountry: z.string().optional(),
  warehouse: z.string().optional(),
  ood: z.string().optional().describe('Origin of data code of the item (e.g. SAP, CN, IN, SMA).'),
  stockClass: z.string().optional().describe('Raw stock class code; srv normalises it via the region config.'),
  additionalCost: z.string().optional().describe('Additional-cost flag value ("0".."4") where the region uses one.'),
  marginOverride: z.number().min(0).max(0.99).optional()
    .describe('Cost-plus only: sell margin as a fraction (0.25 = 25%) replacing the region default.'),
  selectedCostId: z.string().optional().describe('Pick a specific cost candidate instead of the access sequence.'),
}).passthrough();

const draftRef = z.object({
  kind: z.enum(RULE_KINDS),
  key: z.string().min(1),
  version: z.string().min(1),
});

function text(t) {
  return { type: 'text', text: t };
}

function ok(summary, result) {
  return { content: [text(summary), text(JSON.stringify(result, null, 2))] };
}

function fail(err) {
  return { isError: true, content: [text(err.message || String(err))] };
}

function count(list) {
  return Array.isArray(list) ? list.length : 0;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function needsAttention(line) {
  return line.status !== 'PRICED' || (line.flags || []).some((f) => f.level && f.level !== 'info');
}

function summarisePriceResult(result) {
  const items = result?.items || [];
  const priced = items.filter((l) => l.status === 'PRICED').length;
  const attention = items.filter(needsAttention).length;
  const parts = [`${priced} of ${items.length} lines priced`];
  if (attention) parts.push(`${attention} need${attention === 1 ? 's' : ''} attention`);
  if (result?.documentId) parts.push(`document ${result.documentId}`);
  return parts.join(' · ');
}

function summariseDocument(doc) {
  const lines = doc?.result?.items || doc?.items || [];
  const parts = [`Pricing document ${doc?.ID || doc?.id || '(unknown id)'}`, plural(lines.length, 'line')];
  if (doc?.region) parts.push(`region ${doc.region}`);
  if (doc?.priceDate) parts.push(`priced as of ${doc.priceDate}`);
  if (doc?.requestedBy) parts.push(`requested by ${doc.requestedBy}`);
  return parts.join(' · ');
}

function summariseEffective(kind, key, doc) {
  const parts = [`Effective ${kind} "${key}"`];
  if (doc?.version) parts.push(`version ${doc.version}`);
  if (doc?.status) parts.push(doc.status);
  if (doc?.validFrom) parts.push(`valid from ${doc.validFrom}`);
  return parts.join(' · ');
}

function summariseSimulation(draft, result) {
  const lines = result?.items || result?.lines || [];
  const changed = lines.filter((l) => l.delta != null && String(l.delta) !== '0').length;
  const parts = [`Simulated ${draft.kind} "${draft.key}" v${draft.version}`, `${lines.length} lines compared`];
  if (lines.length) parts.push(`${changed} would change`);
  if (count(result?.floorCrossings)) parts.push(`${plural(result.floorCrossings.length, 'floor crossing')}`);
  if (count(result?.deadRows)) parts.push(`${plural(result.deadRows.length, 'dead row')}`);
  return parts.join(' · ');
}

function summariseSuggestion(result) {
  if (result?.status === 'AI_NOT_CONFIGURED') {
    return 'The server has no AI credential configured (AI_NOT_CONFIGURED) — no suggestion was created.';
  }
  const id = result?.id || result?.suggestionId;
  return `Suggestion ${id ? `${id} ` : ''}recorded as ${result?.status || 'PENDING_REVIEW'} — a PricingAdmin must review it in the app before it becomes a draft, and someone still has to publish.`;
}

function createTools(client) {
  const guarded = (fn) => async (args) => {
    try {
      return await fn(args ?? {});
    } catch (err) {
      return fail(err);
    }
  };

  return [
    {
      name: 'whoami',
      description: 'Show which pricing user this session acts for and their roles (PricingViewer / PricingAdmin). '
        + 'Call this first when unsure whether an action will be permitted.',
      inputSchema: {},
      handler: guarded(async () => {
        const me = await client.get(`${PRICING}/whoami`);
        const roles = Array.isArray(me?.roles) ? me.roles.join(', ') : 'none';
        return ok(`Acting on behalf of ${me?.id || 'unknown user'} · roles: ${roles}`, me);
      }),
    },
    {
      name: 'price_items',
      description: 'Price one or more lines for a customer/region as of a date. The engine routes each line to '
        + 'cost plus, price list or catalog + formula (unless pricingType forces one), returns unit price, landed '
        + 'cost, margin, flags and a full step-by-step trace per line, and stores a pricing document whose id you '
        + 'can hand to explain_price later. Lines that cannot be priced come back as MISSING/BLOCKED with a typed '
        + 'reason — never a guessed number. Use purpose BINDING only for a firm quote (it refuses stale/fallback costs).',
      inputSchema: {
        items: z.array(itemSchema).min(1),
        region: z.string().optional()
          .describe('Pricing region (EUROPE, CHINA, INDIA, AMERICAS). Omit to let srv derive it from the customer.'),
        salesOrg: z.string().optional(),
        customerId: z.string().optional().describe('Customer id; drives tier, region derivation and customer discounts.'),
        priceDate: dateString.optional().describe('Effective date for config and cost inputs; defaults to today on the server.'),
        purpose: z.enum(PURPOSES).default('INDICATIVE'),
        hostObjectType: z.string().optional().describe('e.g. QUOTE, OPPORTUNITY, ORDER — what this pricing is for.'),
        hostObjectId: z.string().optional().describe('Id of that object in the host system, for later lookup.'),
      },
      handler: guarded(async ({ items, region, salesOrg, customerId, priceDate, purpose, hostObjectType, hostObjectId }) => {
        const payload = {
          context: { hostSystem: 'MCP', hostObjectType, hostObjectId, purpose },
          party: { customerId, salesOrg },
          region,
          salesOrg,
          customerId,
          priceDate,
          purpose,
          items,
        };
        const result = await client.post(`${PRICING}/price`, payload);
        return ok(summarisePriceResult(result), result);
      }),
    },
    {
      name: 'explain_price',
      description: 'Retrieve a stored pricing document by id: the original request, every line\'s result and the '
        + 'full trace (technique, cost source, each step with its delta, skipped branches and why, config versions). '
        + 'This is the "why" behind a price that was already sent to a customer.',
      inputSchema: {
        documentId: z.string().min(1).describe('documentId returned by price_items (or shown in the app).'),
      },
      handler: guarded(async ({ documentId }) => {
        const doc = await client.get(`${PRICING}/getPricingDocument`, { id: documentId });
        return ok(summariseDocument(doc), doc);
      }),
    },
    {
      name: 'fetch_item_attributes',
      description: 'Look up master-data attributes for parts before pricing — supplier, supplier country, '
        + 'warehouse, stock class, product family/spec/variant and numeric attributes — from the host system via '
        + 'API6. Use it to pre-fill lines or to understand why a line routed to a given technique.',
      inputSchema: {
        items: z.array(z.object({ partNumber: z.string().min(1), quantity: z.number().positive().optional() }).passthrough()).min(1),
        region: z.string().optional(),
        salesOrg: z.string().optional(),
      },
      handler: guarded(async ({ items, region, salesOrg }) => {
        const result = await client.post(`${PRICING}/fetchItemAttributes`, { region, salesOrg, items });
        const n = count(result?.items) || (result && typeof result === 'object' ? Object.keys(result).length : 0);
        return ok(`Attributes resolved for ${plural(n, 'item')}`, result);
      }),
    },
    {
      name: 'get_pricing_rules',
      description: 'Read the pricing rules in force on a date: a region config (build-up, cost access sequence, '
        + 'sell margin, order rules), a price list, a catalog + formula book, or the routing rules that decide '
        + 'which technique applies. Returns the ACTIVE document only — drafts are never used for pricing.',
      inputSchema: {
        kind: z.enum(RULE_KINDS),
        key: z.string().optional()
          .describe('region-config: "REGION" or "REGION/SALESORG"; price-list / catalog-book: the book id; routing-rules: "*" (default).'),
        asOf: dateString.optional().describe('Date to resolve against; defaults to today.'),
      },
      handler: guarded(async ({ kind, key, asOf }) => {
        const resolvedKey = key || (kind === 'routing-rules' ? '*' : undefined);
        if (!resolvedKey) return fail(new Error(`key is required for kind "${kind}" (use list_books to find price list / catalog ids).`));
        const doc = await client.get(`${CONFIG}/getEffective`, { kind, key: resolvedKey, asOf });
        return ok(summariseEffective(kind, resolvedKey, doc), doc);
      }),
    },
    {
      name: 'list_books',
      description: 'List the price lists or catalog + formula books that exist (id, name, currency, where they apply). '
        + 'Use the ids with get_pricing_rules, price_items (book) or simulate_change.',
      inputSchema: { kind: z.enum(BOOK_KINDS) },
      handler: guarded(async ({ kind }) => {
        const result = await client.get(`${CONFIG}/listBooks`, { kind });
        const books = Array.isArray(result) ? result : result?.books || result?.items || [];
        return ok(`${plural(books.length, kind === 'price-list' ? 'price list' : 'catalog book')}`, result);
      }),
    },
    {
      name: 'simulate_change',
      description: 'Price lines with the LIVE rules and with a DRAFT version side by side, without publishing anything. '
        + 'Give explicit items, or documentIds of past pricing documents to re-price, or both. Returns per-line deltas, '
        + 'margin-floor crossings and rows of the draft that nothing would ever hit. Read-only.',
      inputSchema: {
        draft: draftRef.describe('The DRAFT document to test (kind, key, version).'),
        items: z.array(itemSchema).optional(),
        documentIds: z.array(z.string().min(1)).optional(),
        region: z.string().optional(),
        salesOrg: z.string().optional(),
        customerId: z.string().optional(),
        priceDate: dateString.optional(),
      },
      handler: guarded(async ({ draft, items, documentIds, region, salesOrg, customerId, priceDate }) => {
        if (!count(items) && !count(documentIds)) return fail(new Error('Give items and/or documentIds to simulate.'));
        const result = await client.post(`${PRICING}/simulate`, { draft, items, documentIds, region, salesOrg, customerId, priceDate });
        return ok(summariseSimulation(draft, result), result);
      }),
    },
    {
      name: 'propose_rule_change',
      description: 'Turn a plain-language instruction ("raise the EU default margin to 28% from 1 October") into an '
        + 'AI-drafted change against a rules document. Nothing goes live: the result is a PENDING_REVIEW suggestion '
        + 'that a PricingAdmin must approve in the app (that creates a draft), and publishing is a separate human step. '
        + 'Requires the PricingAdmin role.',
      inputSchema: {
        kind: z.enum(RULE_KINDS),
        key: z.string().min(1).describe('Which document: region "EUROPE" / "EUROPE/DE01", a book id, or "*" for routing rules.'),
        instruction: z.string().min(5).describe('What should change and, if relevant, from when.'),
        version: z.string().optional().describe('Base version to change; defaults to the currently ACTIVE one.'),
      },
      handler: guarded(async ({ kind, key, instruction, version }) => {
        const result = await client.post(`${CONFIG}/suggestChange`, { targetKind: kind, targetKey: key, version, instruction });
        return ok(summariseSuggestion(result), result);
      }),
    },
    {
      name: 'list_pending_suggestions',
      description: 'List AI suggestions awaiting human review (default) or in another status, across every rules '
        + 'document kind. Approving or rejecting happens in the app, not here. Requires the PricingAdmin role.',
      inputSchema: {
        status: z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED']).default('PENDING_REVIEW'),
      },
      handler: guarded(async ({ status }) => {
        const result = await client.get(`${CONFIG}/listSuggestions`, { status });
        const list = Array.isArray(result) ? result : result?.suggestions || result?.items || [];
        return ok(`${plural(list.length, 'suggestion')} with status ${status}`, result);
      }),
    },
  ];
}

module.exports = { createTools, RULE_KINDS, BOOK_KINDS, TECHNIQUES, PURPOSES };
