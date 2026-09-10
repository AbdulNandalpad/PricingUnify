/** Unified entry point (ARCHITECTURE_V2 §2.1–2.2): every line is routed to one of the three
 *  techniques and comes back in one shape — status, technique, book, routedBy, result,
 *  flags, trace. Pure like everything else here: srv resolves configs as-of the price date,
 *  normalizes items (supplier terms, stock class, additional-cost flags, quantity breaks,
 *  kits) and product attributes BEFORE calling this. */
const { price } = require('./kernel');
const { resolveTechnique, TECHNIQUES } = require('./routing');
const { pricePriceListItem } = require('./priceList');
const { priceCatalogItem } = require('./catalog');
const { CONFIDENCE } = require('./cost');

function flagsFor(line) {
  const flags = [];
  if (line.status !== 'PRICED') {
    flags.push({ level: 'crit', code: line.missing ? line.missing.reason : line.status, text: line.missing ? (line.missing.detail || line.missing.reason) : line.status });
    return flags;
  }
  const t = line.trace || {};
  if (t.costCandidate && t.costCandidate.confidence && t.costCandidate.confidence !== CONFIDENCE.EXACT) {
    flags.push({ level: 'warn', code: 'COST_CONFIDENCE', text: `Cost confidence is ${t.costCandidate.confidence} — a binding quote needs a confirmed cost.` });
  }
  for (const p of t.constraintPasses || []) {
    if (p.kind === 'MIN_QTY') flags.push({ level: 'warn', code: 'BELOW_MOQ', text: p.warning || `Requested quantity ${p.quantity} is below the minimum order quantity ${p.min}.` });
    else if (p.kind === 'FLOOR') flags.push({ level: 'info', code: 'MOLV_APPLIED', text: p.mode === 'QUANTITY' ? `Minimum order line value ${p.min}: quantity raised ${p.quantityFrom} → ${p.quantityTo}.` : `Minimum order line value ${p.min}: unit price raised to ${p.to}.` });
    else if (p.kind === 'STEP') flags.push({ level: 'info', code: 'STEP_APPLIED', text: `Rounded up to the pack step ${p.step}.` });
  }
  if (t.technique === TECHNIQUES.CATALOG_FORMULA) {
    if (t.source === 'FORMULA') flags.push({ level: 'info', code: 'PRICED_BY_FORMULA', text: 'No negotiated rate exists for this size — priced by the fallback formula.' });
    if (t.floor && t.floor.breached) flags.push({ level: 'crit', code: 'MARGIN_FLOOR', text: `Margin ${pct(t.floor.realised)} is below the ${pct(t.floor.rate)} floor after discount — needs pricing approval.` });
    for (const [name, p] of Object.entries(t.costInputs || {})) {
      if (p && p.confidence && p.confidence !== CONFIDENCE.EXACT) flags.push({ level: 'warn', code: 'COST_INPUT_CONFIDENCE', text: `Cost input ${name} is ${p.confidence} (${p.source}).` });
    }
  }
  if (t.technique === TECHNIQUES.PRICE_LIST && t.resolution) {
    const won = t.resolution.candidates.find((c) => c.won);
    if (won && won.validTo) flags.push({ level: 'info', code: 'ROW_EXPIRES', text: `The matching price list row is valid until ${won.validTo}.` });
  }
  return flags;
}

function pct(v) {
  const n = Number(v) * 100;
  return `${n.toFixed(Math.abs(n % 1) < 1e-9 ? 0 : 1)}%`;
}

function contextOf(request, config) {
  const party = request.party || {};
  return {
    region: (config.region && config.region.region) || party.region || null,
    salesOrg: party.salesOrg || (config.region && config.region.salesOrg) || '*',
    customerId: party.customerId || null,
    tier: party.tier || null,
    priceDate: request.priceDate,
    purpose: (request.context && request.context.purpose) || 'INDICATIVE',
  };
}

function priceItems({ request, facts, config }) {
  if (!request || !facts || !config) throw new Error('priceItems() requires { request, facts, config }.');
  if (!config.region) throw new Error('priceItems() requires config.region (the effective RegionPricingConfig).');
  const ctx = contextOf(request, config);
  const products = facts.items || {};

  const items = request.items.map((item) => {
    const product = products[item.partNumber] || {};
    const route = resolveTechnique(item, product, config, ctx);
    let line;
    if (route.missing) {
      line = { partNumber: item.partNumber, status: 'MISSING', missing: route.missing, trace: { technique: route.technique, steps: [] } };
    } else if (route.technique === TECHNIQUES.PRICE_LIST) {
      line = pricePriceListItem(item, product, config.priceLists[route.book], ctx);
    } else if (route.technique === TECHNIQUES.CATALOG_FORMULA) {
      line = priceCatalogItem(item, product, config.catalogs[route.book], ctx);
    } else {
      line = price({ request: { ...request, items: [item] }, facts, config: config.region }).items[0];
    }
    line.technique = route.technique;
    line.book = route.book;
    line.routedBy = route.routedBy;
    line.trace = { ...(line.trace || {}), technique: route.technique, routedBy: route.routedBy, priceDate: ctx.priceDate };
    line.flags = flagsFor(line);
    return line;
  });

  return { items };
}

module.exports = { priceItems, flagsFor };
