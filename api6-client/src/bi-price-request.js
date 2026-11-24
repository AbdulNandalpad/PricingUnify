'use strict';

/**
 * Builds the request for API6's BI price endpoint (`/core/price/rest/v1/getPriceList`) from the
 * C4C-shaped body (`customer{...}` + `item[]`), applying exactly what the CPI Groovy step used to
 * do before calling API6 — because the call now goes straight to API6, with no CPI in between.
 *
 * The rules are DATA (`DEFAULT_REQUEST_MAPPING`, overridable per deployment through the
 * connection-config `api6.requestMapping`), not branches in code, and the input is never mutated.
 * Rule order matches the Groovy script (it matters: the supplier-clearing rule blanks the
 * supplier code that the stock-class override reads):
 *   1. unitCode mapping            (CMT -> CM)
 *   2. uom mapping                 (MMT -> mm, CMT -> cm, INH -> in)
 *   3. blank item cost currency    -> the customer's currency
 *   4. stock-class override rules  (US customer + warehouse 1020 + supplier L_LCE -> MTS)
 *   4b. (ours) blank itemTypeDesc -> mapping.defaultItemTypeDesc, so rule 5 doesn't fire for lines
 *       whose host never supplied an item type
 *   5. no itemTypeDesc AND no opportunityId -> flag "0", supplier code + country cleared
 *   6. opportunityId present       -> flag "0"
 *   7. strip leading zeros         (supplierExternalID 0001025397 -> 1025397)
 */
const DEFAULT_REQUEST_MAPPING = Object.freeze({
  unitCodeMap: { CMT: 'CM' },
  uomMap: { MMT: 'mm', CMT: 'cm', INH: 'in' },
  defaultCostCurrencyFromCustomer: true,
  stockClassOverrides: [
    { customerCountry: 'US', warehouseCode: '1020', supplierMainGroupCode: 'L_LCE', stockClassGroupCode: 'MTS' },
  ],
  // The neutral request does not carry C4C's item type. Without ANY item type the CPI rule below
  // blanks the supplier code + country, which starves the cost lookup — so it is defaulted here,
  // visibly, and editable (Connections tab). The real C4C samples carry the processing type CODE
  // "AGN" (retrivePriceBI sends it.ProcessingTypeCode) — but with the sparse request we can build
  // for a hand-added line, "AGN" made the gateway answer "Cost was neither handed over nor found
  // in price list", while "AGN - Product" (the C4C screen's label) returned the CCD cost. So the
  // default is the value that was seen to work; change it on the Connections tab to test others.
  defaultItemTypeDesc: 'AGN - Product',
  clearSupplierWithoutItemTypeOrOpportunity: true,
  zeroCostPlusFlagForOpportunity: true,
  stripLeadingZerosFrom: ['supplierExternalID'],
});

const text = (v) => (v === undefined || v === null ? '' : String(v));
const blank = (v) => text(v).trim() === '';

function buildBiPriceRequest(c4cBody, mappingOverride) {
  const mapping = { ...DEFAULT_REQUEST_MAPPING, ...(mappingOverride || {}) };
  const body = JSON.parse(JSON.stringify(c4cBody || {}));
  const customer = body.customer || {};
  const items = Array.isArray(body.item) ? body.item : (body.item && typeof body.item === 'object' ? [body.item] : []);
  const hasOpportunity = !blank(customer.opportunityId);

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    if (mapping.unitCodeMap && Object.prototype.hasOwnProperty.call(mapping.unitCodeMap, text(item.unitCode))) {
      item.unitCode = mapping.unitCodeMap[text(item.unitCode)];
    }
    if (item.uom !== undefined && item.uom !== null && mapping.uomMap && Object.prototype.hasOwnProperty.call(mapping.uomMap, text(item.uom))) {
      item.uom = mapping.uomMap[text(item.uom)];
    }
    if (mapping.defaultCostCurrencyFromCustomer && blank(item.costCurrencyCode)) {
      item.costCurrencyCode = text(customer.custcurrency);
    }
    for (const rule of mapping.stockClassOverrides || []) {
      if (text(customer.countryCode) === rule.customerCountry
        && text(item.warehouseCode) === rule.warehouseCode
        && text(item.supplierMainGroupCode) === rule.supplierMainGroupCode) {
        item.stockClassGroupCode = rule.stockClassGroupCode;
      }
    }
    if (mapping.defaultItemTypeDesc && blank(item.itemTypeDesc) && !hasOpportunity) {
      item.itemTypeDesc = mapping.defaultItemTypeDesc;
    }
    if (mapping.clearSupplierWithoutItemTypeOrOpportunity && blank(item.itemTypeDesc) && !hasOpportunity) {
      item.useCostPlusFlag = '0';
      item.supplierMainGroupCode = '';
      item.supplierCountryCode = '';
    }
    if (mapping.zeroCostPlusFlagForOpportunity && hasOpportunity) {
      item.useCostPlusFlag = '0';
    }
    for (const field of mapping.stripLeadingZerosFrom || []) {
      if (item[field] !== undefined && item[field] !== null) {
        item[field] = text(item[field]).replace(/^0+(?!$)/, '');
      }
    }
  }
  body.item = items;
  // The CPI step also kept the customer's originOfData for its after-response step; it is
  // returned alongside so a caller that needs it for the response has it.
  return { body, context: { originOfData: text(customer.originOfData) } };
}

/**
 * Normalizes the BI answer: `status.statusCode` SUCCESS (anything else = FAILED with the fault
 * messages) and one entry per calculatedPriceList line, keyed by the lineId C4C sent.
 */
function parseBiPriceResponse(res) {
  const status = res && res.status;
  const code = status && typeof status === 'object' ? text(status.statusCode) : text(status);
  if (!/SUCCESS/i.test(code)) {
    const faults = status && Array.isArray(status.faultMessage) ? status.faultMessage.map(text).filter(Boolean) : [];
    return { status: 'FAILED', message: faults.join('; ') || (res && res.message) || `API6 answered ${code || 'no status'}`, lines: [] };
  }
  const list = Array.isArray(res.calculatedPriceList) ? res.calculatedPriceList : [];
  return {
    status: 'OK',
    lines: list.map((l) => ({
      lineId: text(l.lineId),
      partNumber: text(l.itemLongNbr),
      quantity: text(l.salesQuantity),
      costPlusUnitAmt: l.costPlusUnitAmt === null || l.costPlusUnitAmt === undefined ? null : text(l.costPlusUnitAmt),
      costCurrencyCode: text(l.costCurrencyCode),
      priceCurrencyCode: text(l.priceCurrencyCode),
      unitPriceAmt: l.unitPriceAmt === null || l.unitPriceAmt === undefined ? null : text(l.unitPriceAmt),
      fromQty: l.fromQty === null || l.fromQty === undefined ? null : text(l.fromQty),
      costAvailableFromQty: l.costAvailableFromQty === null || l.costAvailableFromQty === undefined ? null : text(l.costAvailableFromQty),
      costFetchedFrom: text(l.costFechedFrom),
      messageCode: l.messageCode === null || l.messageCode === undefined ? '' : text(l.messageCode),
      ccpMessage: l.ccpMsg === null || l.ccpMsg === undefined ? '' : text(l.ccpMsg),
      explainCost: text(l.explainCostDesc),
      explainPrice: text(l.explainPriceDesc),
    })),
  };
}

module.exports = { buildBiPriceRequest, parseBiPriceResponse, DEFAULT_REQUEST_MAPPING };
