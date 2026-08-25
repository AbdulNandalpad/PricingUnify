/** The 5 element primitives. See requirements §5.1.
 *  BASE | FACTOR (basis REQUIRED) | ADDER | PER_LINE | CONSTRAINT
 *  MROQ is routing input, NOT a constraint. COMPOSITE factors tagged allocatable:false. */
const ELEMENT_TYPES = Object.freeze(['BASE','FACTOR','ADDER','PER_LINE','CONSTRAINT']);
module.exports = { ELEMENT_TYPES };
