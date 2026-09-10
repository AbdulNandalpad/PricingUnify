/** Price list technique (ARCHITECTURE_V2 §2.6): a SELL price read from a table, resolved
 *  most-specific-wins across the book's dimensions, tiered by quantity, then customer
 *  discount and order rules. Note the deliberate difference from TSS's supplier
 *  quantity-break table: that one is a COST source and stays inside cost plus. */
const Decimal = require('decimal.js');
const { resolveRows, tierValue, describeMatch } = require('./rules');
const { applyConstraint } = require('./elements');
const { roundTo } = require('./rounding');
const trace = require('./trace');

const DEFAULT_ROUNDING = { mode: 'HALF_UP', decimalPlaces: 2 };

function missingLine(item, book, reason, detail, extra = {}) {
  return {
    partNumber: item.partNumber,
    status: 'MISSING',
    missing: { reason, detail },
    trace: { technique: 'PRICE_LIST', book: book.id, bookVersion: book.version, steps: [], ...extra },
  };
}

/** ctx: { region, salesOrg, customerId, tier, priceDate, purpose } — srv fills these from the
 *  request + party-config. `product` = the part's master-data attributes (facts.items). */
function pricePriceListItem(item, product, book, ctx) {
  const quantity = Number(item.quantity);
  const attrs = { ...product, customer: ctx.customerId, tier: ctx.tier, region: ctx.region, salesOrg: ctx.salesOrg };
  const partRows = (book.rows || []).filter((r) => r.part === item.partNumber);
  if (partRows.length === 0) {
    return missingLine(item, book, 'NO_LIST_PRICE', `${item.partNumber} has no row in price list "${book.name || book.id}".`);
  }

  const resolution = resolveRows(partRows, attrs, book.dimensions, ctx.priceDate);
  if (resolution.ambiguous) {
    return missingLine(item, book, 'AMBIGUOUS_RULE', `Two rows for ${item.partNumber} match with equal specificity — the price list must be fixed.`, { resolution: summarize(resolution) });
  }
  if (!resolution.winner) {
    return missingLine(item, book, 'NO_MATCHING_ROW', `No price list row for ${item.partNumber} applies to this customer/region on ${ctx.priceDate}.`, { resolution: summarize(resolution) });
  }

  const tier = tierValue(resolution.winner.row.tiers, quantity);
  if (!tier) {
    return missingLine(item, book, 'NO_TIER', `Quantity ${quantity} is below the first tier of the matching row.`, { resolution: summarize(resolution) });
  }

  const steps = [];
  let running = new Decimal(tier.value);
  steps.push(trace.step('LIST_PRICE', 'RULE', {
    delta: running,
    runningTotal: running,
    note: { row: describeMatch(resolution.winner.row.match), specificity: resolution.winner.specificity, tierFrom: tier.from, source: 'PRICE_LIST' },
  }));

  const discount = resolveRows(book.discount || [], attrs, book.dimensions, ctx.priceDate);
  if (discount.ambiguous) {
    return missingLine(item, book, 'AMBIGUOUS_RULE', 'Two discount rows match with equal specificity.', { resolution: summarize(resolution) });
  }
  const discountRate = discount.winner ? new Decimal(discount.winner.row.value) : new Decimal(0);
  if (discountRate.isZero()) {
    steps.push(trace.step('CUST_DISC', 'PERCENT', { delta: new Decimal(0), runningTotal: running, note: { skipped: true, reason: discount.winner ? 'RATE_ZERO' : 'NO_MATCHING_ROW' } }));
  } else {
    const delta = running.times(discountRate).neg();
    running = running.plus(delta);
    steps.push(trace.step('CUST_DISC', 'PERCENT', { delta, runningTotal: running, note: { rate: discountRate.toString(), row: describeMatch(discount.winner.row.match), basis: ['LIST_PRICE'] } }));
  }

  const constraintPasses = [];
  let resultQuantity = quantity;
  for (const c of book.constraints || []) {
    const res = applyConstraint(c, running, { facts: { elements: {} }, quantity: resultQuantity });
    if (res.applied) {
      constraintPasses.push({ id: c.id, from: running.toString(), to: res.total.toString(), ...res.note });
      running = res.total;
      if (res.quantity) resultQuantity = res.quantity.toNumber();
    }
  }

  running = roundTo(running, book.rounding || DEFAULT_ROUNDING);

  return {
    partNumber: item.partNumber,
    status: 'PRICED',
    result: { unitPrice: running.toString(), landedCost: null, margin: null, currency: book.currency, quantity: resultQuantity },
    trace: {
      technique: 'PRICE_LIST',
      book: book.id,
      bookVersion: book.version,
      attributes: attrs,
      resolution: summarize(resolution),
      tier: { from: tier.from, value: String(tier.value) },
      steps,
      constraintPasses,
    },
  };
}

function summarize(resolution) {
  return {
    ambiguous: resolution.ambiguous,
    candidates: resolution.candidates.map((c) => ({
      match: c.row.match || {},
      description: describeMatch(c.row.match),
      specificity: c.specificity,
      tiers: c.row.tiers ? c.row.tiers.map((t) => ({ from: t.from, value: String(t.value) })) : undefined,
      value: c.row.value !== undefined ? String(c.row.value) : undefined,
      validFrom: c.row.validFrom || null,
      validTo: c.row.validTo || null,
      won: c.won,
      reason: c.reason,
    })),
  };
}

module.exports = { pricePriceListItem, summarizeResolution: summarize, DEFAULT_ROUNDING };
