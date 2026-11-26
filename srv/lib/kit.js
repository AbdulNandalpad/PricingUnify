'use strict';

/**
 * KIT (sales BOM) rules, modeled on how standard SAP SD handles a BOM in a sales document:
 *
 *  - A kit HEADER item is exploded into COMPONENT items. SAP numbers them with a sub-item
 *    increment (default 1) under the header, and the next ordinary item continues from the highest
 *    number used with the normal item increment (10): header 10 -> components 11, 12, 13 ... -> next item 20
 *    (more than 9 components simply run past 19 and the next item starts at the next multiple of 10 above them).
 *  - Component quantity = ordered kit quantity x the BOM quantity per kit (SAP's BOM explosion).
 *  - Pricing sits on the HEADER ("pricing at header level"): its cost, price and margin are the
 *    roll-up of its components; a margin entered on the header applies to every component.
 *
 * Everything here is pure (no I/O); the money math is decimal.js, never float.
 */
const Decimal = require('decimal.js');

/** A line is a kit header when it carries components, or is C4C's kit item type (ZKIT). */
function isKitHeader(item) {
  return (Array.isArray(item.components) && item.components.length > 0) || item.itemType === 'ZKIT';
}

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Item numbers for a kit's components: header+1, header+2, ... (sub-item increment 1), skipping any
 * number already used by another line so nothing collides. `used` is any iterable of item numbers.
 */
function numberKitComponents(headerItemNo, count, used = [], subItemIncrement = 1) {
  const header = toInt(headerItemNo);
  if (header === null) return Array.from({ length: count }, () => null);
  const taken = new Set([...used].map(toInt).filter((n) => n !== null));
  taken.add(header);
  const out = [];
  let next = header;
  while (out.length < count) {
    next += subItemIncrement;
    if (taken.has(next)) continue;
    out.push(next);
    taken.add(next);
  }
  return out;
}

/** Next ordinary (top-level) item number: the next multiple of 10 above everything used, components included. */
function nextItemNumber(used = [], increment = 10) {
  const max = Math.max(0, ...[...used].map(toInt).filter((n) => n !== null));
  return Math.floor(max / increment) * increment + increment;
}

/**
 * Roll the component results up into the header's figures. `components` is
 * [{ line, perKitQuantity }] where `line` is a PRICED engine line. Amounts on a component line are per
 * ITS priceUnit pieces, so each is divided down to one piece, then multiplied by how many the kit holds.
 * Returns plain decimals (unrounded); the caller applies the region's declared rounding and the header's own price unit.
 */
function rollUp(components) {
  let landed = new Decimal(0);
  let selling = new Decimal(0);
  let allHaveSelling = components.length > 0;
  for (const { line, perKitQuantity } of components) {
    const unit = new Decimal(line.result.priceUnit || 1);
    const qty = new Decimal(perKitQuantity);
    const landedAmount = line.result.landedCost !== undefined ? line.result.landedCost : line.result.unitPrice;
    landed = landed.plus(new Decimal(landedAmount).div(unit).times(qty));
    if (line.result.sellingPrice === undefined) allHaveSelling = false;
    else selling = selling.plus(new Decimal(line.result.sellingPrice).div(unit).times(qty));
  }
  const marginPct = allHaveSelling && selling.gt(0) ? selling.minus(landed).div(selling).times(100) : null;
  return { landed, selling: allHaveSelling ? selling : null, marginPct };
}

module.exports = { isKitHeader, numberKitComponents, nextItemNumber, rollUp };
