const Decimal = require('decimal.js');

const ROUNDING_MODES = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  UP: Decimal.ROUND_UP,
  DOWN: Decimal.ROUND_DOWN,
  CEIL: Decimal.ROUND_CEIL,
  FLOOR: Decimal.ROUND_FLOOR,
};

/** Declared rounding only (requirements §5.3): `{ mode, decimalPlaces }`. No rounding
 *  declared -> the value is returned untouched, full precision. */
function roundTo(value, rounding) {
  if (!rounding || rounding.decimalPlaces === undefined || rounding.decimalPlaces === null) return value;
  const mode = ROUNDING_MODES[rounding.mode] ?? Decimal.ROUND_HALF_UP;
  return value.toDecimalPlaces(rounding.decimalPlaces, mode);
}

module.exports = { ROUNDING_MODES, roundTo };
