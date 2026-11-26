'use strict';

const { z } = require('zod');
const { PricingApiError } = require('./client');
const { toApiItem, summarizeRun, explainLine } = require('./summarize');

/**
 * MCP tool definitions. Each is a thin, typed wrapper over one REST action; the backend
 * keeps all pricing logic and all authorization. Deliberately NOT exposed (agents get read /
 * calculate only):
 *   - writeBackToC4C and every config save/approve action — outward-facing or config-changing,
 *     and config never changes without a human (project non-negotiable);
 *   - the C4C facade actions — those are for C4C's own ABSL, not for agents.
 */

const PRICING_TYPE = z.enum(['COST_PLUS', 'PRICE_LIST']);
const STOCK_CLASS = z.enum(['MTS', 'NonMTS']);

/** One component of a kit: a part and how many of it ONE kit contains. */
const componentShape = z.object({
  partNumber: z.string().min(1),
  quantity: z.number().positive().describe('How many of this component ONE kit contains.'),
  supplier: z.string().optional(),
  supplierCountry: z.string().optional(),
  warehouse: z.string().optional(),
  ood: z.string().optional(),
  stockClass: STOCK_CLASS.optional(),
  additionalCost: z.union([z.string(), z.number()]).optional(),
  itemType: z.string().optional(),
  priceUnit: z.number().positive().optional(),
}).strict();

const itemShape = z.object({
  partNumber: z.string().min(1).describe('Product / part number, e.g. "EU-T100".'),
  quantity: z.number().positive().describe('Ordered quantity in the part\'s own unit (pieces).'),
  supplier: z.string().optional().describe('Supplier ID (GlobalSupplierCode, e.g. "X_SIL"). With a warehouse it selects that supplier\'s freight/duty/tariff terms.'),
  supplierCountry: z.string().optional().describe('Supplier country code. Resolved from the supplier master when omitted.'),
  warehouse: z.string().optional().describe('Destination warehouse code (e.g. "1020"). Needed together with supplier for freight/duty/tariff.'),
  ood: z.string().optional().describe('Origin of Data code of the line (SAP, SMA, CN, IN).'),
  stockClass: STOCK_CLASS.optional().describe('Override the stock class. Normally resolved automatically — leave unset unless you know it.'),
  additionalCost: z.union([z.string(), z.number()]).optional().describe('C4C "Additional Cost" flag (0 nothing to add, 1 landed cost & markup, 4 …no tariff). C4C default is 1.'),
  itemType: z.string().optional().describe('C4C item/processing type code, e.g. "AGN" (product), "ZTOL", "ZSRV".'),
  pricingType: PRICING_TYPE.optional().describe('COST_PLUS (default: cost source + configured add-ons) or PRICE_LIST (supplier price-list cost, then the same add-ons). Needs supplier or productCategory.'),
  productCategory: z.string().optional().describe('Product category — the price-list lookup key when no supplier is given.'),
  priceUnit: z.number().positive().optional().describe('Price/cost unit: amounts are per this many pieces. Default 1 at the API (C4C uses 100).'),
  marginPct: z.number().min(0).lt(100).optional().describe('Margin as % of the SELLING price (0 ≤ m < 100): sellingPrice = landedCost ÷ (1 − m/100). Omit for pure landed cost (a predefined regional margin rule may still apply).'),
  manualPrice: z.number().positive().optional().describe('A selling price per priceUnit. Wins over marginPct; the resulting margin is derived.'),
  components: z.array(componentShape).min(1).max(100).optional().describe('Makes this line a KIT (sales BOM), in ANY region: component quantity = kit quantity x quantity in one kit; the kit\'s cost, price and margin are the roll-up of its components (a margin on the kit applies to every component). Omit components and set itemType "ZKIT" to have them fetched from the ERP behind the line\'s Origin of Data. Every component must price, or the whole kit is MISSING.'),
}).strict();

const scopeShape = {
  region: z.enum(['EUROPE', 'AMERICAS', 'CHINA', 'INDIA']).optional()
    .describe('Pricing region. Omit only if you pass customerOod (or customerId with stored master data) so it can be routed.'),
  salesOrg: z.string().optional().describe('Sales org; "*" (default) = the region-wide configuration.'),
  customerOod: z.string().optional().describe('Customer Origin of Data, used to derive the region when region is omitted.'),
  customerId: z.string().optional().describe('Customer ID (ERP number); looked up in stored customer master data.'),
  hostObjectType: z.enum(['QUOTE', 'OPPORTUNITY']).optional().describe('OPPORTUNITY = cost only: landed cost is returned, never a price or margin. Default QUOTE.'),
  priceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Pricing date (YYYY-MM-DD) selecting the effective-dated configuration. Default today.'),
};

function payloadFrom(args, items) {
  const p = { items: items.map(toApiItem) };
  for (const k of ['region', 'salesOrg', 'customerOod', 'customerId', 'hostObjectType', 'priceDate']) {
    if (args[k] !== undefined) p[k] = args[k];
  }
  p.hostSystem = 'MCP';
  return p;
}

function ok(structured, text) {
  return {
    content: [{ type: 'text', text: text || JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function fail(e) {
  let message;
  if (e instanceof PricingApiError) {
    message = e.message;
    if (e.status === 401) message += ' — the pricing API rejected the credentials this MCP server was given.';
    if (e.status === 403) message += ' — these credentials lack the required role (PricingViewer for pricing, PricingAdmin for configuration).';
  } else {
    message = `Unexpected error: ${e && e.message ? e.message : String(e)}`;
  }
  return { isError: true, content: [{ type: 'text', text: message }] };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/**
 * @param {object} deps  { getClient: () => client }  — resolved per call so the HTTP transport
 *                       can hand each MCP caller's own credentials through.
 * @param {object} opts  { enableAdmin: boolean }
 */
function buildTools({ getClient }, { enableAdmin = false } = {}) {
  const tools = [
    {
      name: 'price_items',
      title: 'Price items (landed cost / selling price)',
      description: 'Calculate the landed cost — and, when a margin or price is given, the selling price — for one or more parts with the TSS pricing engine. Applies the region\'s configured build-up (markup, freight, duty, tariff, pick, …) on the part\'s cost. Each line is PRICED or MISSING with a typed reason; nothing is guessed. Amounts are per `priceUnit` pieces.',
      inputSchema: { ...scopeShape, items: z.array(itemShape).min(1).max(200).describe('Lines to price (max 200).') },
      annotations: READ_ONLY,
      handler: async (args) => {
        const body = await getClient().post('/rest/pricing/price', { payload: payloadFrom(args, args.items) });
        const s = summarizeRun(body);
        return ok(s);
      },
    },
    {
      name: 'explain_price',
      title: 'Explain how a price was calculated',
      description: 'Price ONE part and return the step-by-step calculation in plain language: which cost source was used and why, each configured step with its rate and running total, skipped steps with the unmet condition, rules applied, and the configuration version. Use this to answer "why is this the price?".',
      inputSchema: { ...scopeShape, item: itemShape },
      annotations: READ_ONLY,
      handler: async (args) => {
        const body = await getClient().post('/rest/pricing/price', { payload: payloadFrom(args, [args.item]) });
        const line = (body.items || [])[0];
        if (!line) return ok({ status: 'NO_RESULT' }, 'The pricing API returned no line.');
        return ok({ summary: summarizeRun(body).lines[0], steps: (line.trace && line.trace.steps) || [] }, explainLine(line, body));
      },
    },
    {
      name: 'get_item_attributes',
      title: 'Resolve item attributes',
      description: 'Preview what the engine resolves for each part before pricing — supplier, supplier country, warehouse and stock class (MTS / NonMTS) — without calculating a price. Useful to check a line is complete (a part with an unresolved stock class will price as MISSING).',
      inputSchema: { ...scopeShape, items: z.array(itemShape).min(1).max(200) },
      annotations: READ_ONLY,
      handler: async (args) => {
        const body = await getClient().post('/rest/pricing/fetchItemAttributes', { payload: payloadFrom(args, args.items) });
        return ok({ region: body.region && body.region.value, attributes: body.attributes });
      },
    },
    {
      name: 'search_products',
      title: 'Search products',
      description: 'Type-ahead search for part numbers. Answers from the C4C product master when connected, otherwise from the region\'s local recorded catalog — the `source` field says which (C4C | LOCAL_CATALOG).',
      inputSchema: { query: z.string().min(2).describe('Start of a part number (min 2 characters).'), region: scopeShape.region },
      annotations: READ_ONLY,
      handler: async (args) => {
        const body = await getClient().post('/rest/pricing/searchC4cProducts', { payload: { query: args.query, region: args.region } });
        return ok(body);
      },
    },
    {
      name: 'get_kit_components',
      title: 'Get a kit\'s components',
      description: 'Preview the components of one or more kits (sales BOMs) as the ERP behind each kit\'s Origin of Data returns them, numbered the way SAP numbers sub-items (header 10 -> 11, 12, 13). Quantities are PER ONE KIT. A kit header can also be priced directly with price_items (itemType "ZKIT", no components needed): its components are fetched the same way. Typed status per kit: OK | NOT_FOUND | FAILED | OOD_UNKNOWN.',
      inputSchema: {
        region: scopeShape.region,
        kits: z.array(z.object({
          partNumber: z.string().min(1).describe('The kit header\'s part number.'),
          ood: z.string().optional().describe('Origin of Data of the kit (SAP, SMA, CN, IN). Omit to use the region\'s own when it has exactly one.'),
          itemNo: z.number().int().positive().optional().describe('The header\'s item number, to get component numbers (header + 1, + 2, ...).'),
        }).strict()).min(1).max(50),
      },
      annotations: READ_ONLY,
      handler: async (args) => ok(await getClient().post('/rest/pricing/fetchKitComponents', { payload: { region: args.region, kits: args.kits } })),
    },
    {
      name: 'whoami',
      title: 'Check access',
      description: 'Return the identity the pricing API sees for this connection and which roles it holds (PricingViewer = pricing; PricingAdmin = also configuration). Call this first if another tool answers 401/403.',
      inputSchema: {},
      annotations: READ_ONLY,
      handler: async () => ok(await getClient().get('/rest/pricing/me')),
    },
  ];

  if (enableAdmin) {
    tools.push(
      {
        name: 'get_region_config',
        title: 'Read a region\'s pricing configuration',
        description: 'READ-ONLY. The effective pricing configuration of a region as of a date: build-up steps, constraints, cost-source order, stock-class rules, margin rules. Requires PricingAdmin. This server cannot change configuration.',
        inputSchema: { region: scopeShape.region.unwrap(), salesOrg: z.string().optional(), asOf: scopeShape.priceDate },
        annotations: READ_ONLY,
        handler: async (args) => {
          const q = `region='${encodeURIComponent(args.region)}',salesOrg='${encodeURIComponent(args.salesOrg || '*')}'${args.asOf ? `,asOf='${args.asOf}'` : ''}`;
          return ok(await getClient().get(`/rest/config/getEffectiveConfig(${q})`));
        },
      },
      {
        name: 'list_suppliers',
        title: 'List suppliers and their landed-cost terms',
        description: 'READ-ONLY. Suppliers with country, MOLV and per-warehouse freight / duty / tariff rates (as ratios: 0.18 = 18 %). Requires PricingAdmin.',
        inputSchema: {},
        annotations: READ_ONLY,
        handler: async () => ok(await getClient().get('/rest/config/listSuppliers()')),
      },
    );
  }
  return tools;
}

/** Register the tools on an McpServer, converting thrown API errors into MCP tool errors. */
function registerTools(server, deps, opts) {
  for (const t of buildTools(deps, opts)) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations },
      async (args) => {
        try { return await t.handler(args || {}); } catch (e) { return fail(e); }
      },
    );
  }
}

module.exports = { buildTools, registerTools, fail };
