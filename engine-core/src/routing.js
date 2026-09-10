/** Which pricing technique prices a line (ARCHITECTURE_V2 §2.5). Order of precedence,
 *  the same "explicit selection always wins" rule used everywhere else in this engine:
 *   1. item.pricingType — the user's own choice for this line (routedBy USER);
 *   2. config.routing.rules, top to bottom, on the part's attributes — AND the target
 *      book's own appliesWhen scope must fit (routedBy RULE:<index>);
 *   3. cost plus with the region's landed-cost rules (routedBy DEFAULT). */

const TECHNIQUES = Object.freeze({ COST_PLUS: 'COST_PLUS', PRICE_LIST: 'PRICE_LIST', CATALOG_FORMULA: 'CATALOG_FORMULA' });

function booksOf(config, technique) {
  if (technique === TECHNIQUES.PRICE_LIST) return config.priceLists || {};
  if (technique === TECHNIQUES.CATALOG_FORMULA) return config.catalogs || {};
  return {};
}

/** `appliesWhen: { region: 'EUROPE', family: 'O-Rings' }` — `region` (and `salesOrg`) are
 *  compared against the pricing context, everything else against the part's attributes. */
function appliesTo(book, product, ctx) {
  return Object.entries(book.appliesWhen || {}).every(([k, v]) => {
    const actual = k === 'region' || k === 'salesOrg' ? ctx[k] : product[k];
    return actual !== undefined && actual !== null && String(actual) === String(v);
  });
}

function ruleFits(rule, product) {
  return Object.entries(rule.when || {}).every(([k, v]) => product[k] !== undefined && product[k] !== null && String(product[k]) === String(v));
}

function resolveTechnique(item, product, config, ctx) {
  if (item.pricingType) {
    if (item.pricingType === TECHNIQUES.COST_PLUS) return { technique: TECHNIQUES.COST_PLUS, book: null, routedBy: 'USER' };
    const books = booksOf(config, item.pricingType);
    const book = item.book && books[item.book]
      ? books[item.book]
      : Object.values(books).find((b) => appliesTo(b, product, ctx)) || Object.values(books)[0] || null;
    if (!book) return { technique: item.pricingType, book: null, routedBy: 'USER', missing: { reason: 'NO_BOOK', detail: `No ${item.pricingType} book exists.` } };
    return { technique: item.pricingType, book: book.id, routedBy: 'USER' };
  }

  const rules = (config.routing && config.routing.rules) || [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!ruleFits(rule, product)) continue;
    const book = booksOf(config, rule.type)[rule.book];
    if (!book) continue;
    if (!appliesTo(book, product, ctx)) continue;
    return { technique: rule.type, book: book.id, routedBy: `RULE:${i}` };
  }
  return { technique: TECHNIQUES.COST_PLUS, book: null, routedBy: 'DEFAULT' };
}

module.exports = { TECHNIQUES, resolveTechnique, appliesTo, ruleFits };
