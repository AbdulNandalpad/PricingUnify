'use strict';

/**
 * Per-LINE facts. API6 delivers facts keyed by part number, but a request can carry the same
 * part on several lines (price breaks, different suppliers or warehouses, different host costs)
 * and every pricing step that adds to a part's facts — supplier terms, host cost, quantity-break
 * candidate, BI cost — is specific to ONE line. Writing those into a part-keyed entry made the
 * last line win for all of them. So before any step runs, each line gets its own copy of its
 * part's facts under a unique `factsKey`; every step and the engine kernel then read and write
 * by that key (the kernel falls back to partNumber when no factsKey is set, so direct callers
 * of engine-core are unaffected).
 */

const SECTIONS = ['costs', 'elements', 'classification', 'qtyBreaks', 'itemAttributes'];

function factsKeyOf(item) {
  return item.factsKey !== undefined && item.factsKey !== null ? item.factsKey : item.partNumber;
}

/** Give each line its own facts entry. `prefix` keeps keys unique across separate calls. */
function materializeLineFacts(facts, items, prefix = 'L') {
  items.forEach((item, i) => {
    const key = `${prefix}${i}`;
    for (const section of SECTIONS) {
      if (!facts[section]) continue;
      const own = facts[section][item.partNumber];
      if (own !== undefined) facts[section][key] = structuredClone(own);
    }
    item.factsKey = key;
  });
  return items;
}

module.exports = { factsKeyOf, materializeLineFacts, SECTIONS };
