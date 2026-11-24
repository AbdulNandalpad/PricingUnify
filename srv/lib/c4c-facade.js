/**
 * C4C-compatible facade (owner decision 2026-11-24): the request/response contract that
 * Trelleborg's C4C ABSL (`retrivePriceBI`, `getCostPoints`/`getPricePoints`) already speaks
 * against the BI price service — reproduced here so PricingUnify can take that service's
 * seat with ZERO changes to the ABSL callers (only the WSO2 route moves).
 *
 * Contract source: the DEV2605 solution export (see CLAUDE.md decision log 2026-11-24).
 * Everything here TRANSLATES between that contract and the neutral pricing request — no
 * pricing logic lives in this file.
 */
const Decimal = require('decimal.js');

function isGiven(v) {
  return v !== undefined && v !== null && String(v).trim() !== '' && String(v) !== 'null';
}

function fmt2(v) {
  return new Decimal(v).toFixed(2);
}

/**
 * C4C payload -> neutral pricing payload + per-line echo metadata (zip by position: the
 * response echoes each line's lineId so ABSL matches results back to quote items).
 */
function translateCustomerPriceListRequest(c4cPayload, { store, priceDate }) {
  const customer = c4cPayload.customer || {};
  const rawItems = Array.isArray(c4cPayload.item) ? c4cPayload.item : [];
  if (rawItems.length === 0) return { error: 'No items in request.' };

  const ood = isGiven(customer.originOfData) ? String(customer.originOfData).trim() : null;
  if (!ood) return { error: 'customer.originOfData is required to resolve the pricing region.' };

  // Same region-route table the neutral API uses (never a silent guess).
  const route = store.getEffectiveRegionRoute(ood, '*', priceDate);
  if (!route) return { error: `Cannot resolve a region from originOfData "${ood}" — no matching region-route.` };
  const region = route.region;
  const config = store.getEffectiveAsOf(region, '*', priceDate);
  if (!config) return { error: `No effective pricing configuration for region "${region}".` };

  const meta = [];
  const items = rawItems.map((it) => {
    const partNumber = isGiven(it.itemLongNumber) ? String(it.itemLongNumber).trim() : String(it.itemShortNumber || '').trim();
    const item = { partNumber, quantity: Number(it.salesQuantity) || 1, pricingType: 'COST_PLUS' };
    if (isGiven(it.warehouseCode)) item.warehouse = String(it.warehouseCode).trim();
    if (isGiven(it.supplierExternalID)) item.supplier = String(it.supplierExternalID).trim();
    if (isGiven(it.supplierCountryCode)) item.supplierCountry = String(it.supplierCountryCode).trim();
    item.ood = ood;

    // C4C sends the RAW stock-class group code (MTS/MTO/MTC/OMT/...). Translation goes
    // through the region's own stockClassMap — config, never a hardcoded heuristic; an
    // unmapped code is the same typed MISSING the normal pipeline produces.
    if (isGiven(it.stockClassGroupCode) && config.stockClassMap) {
      const raw = String(it.stockClassGroupCode).trim();
      if (Object.prototype.hasOwnProperty.call(config.stockClassMap, raw)) {
        item.stockClass = config.stockClassMap[raw];
      } else {
        item.stockClassError = `STOCK_CLASS_UNMAPPED:${raw}`;
      }
    }

    meta.push({
      lineId: isGiven(it.lineId) ? String(it.lineId) : '',
      itemLongNbr: partNumber,
      incomingPrice: isGiven(it.c4cUnitPriceAmt) && Number(it.c4cUnitPriceAmt) > 0 ? String(it.c4cUnitPriceAmt).trim() : '',
      priceCurrency: isGiven(it.priceCurrencyCode) ? String(it.priceCurrencyCode).trim() : '',
    });
    return item;
  });

  return {
    region,
    meta,
    payload: {
      customerOod: ood,
      salesOrg: '*',
      hostSystem: 'C4C',
      hostObjectType: 'QUOTE',
      hostObjectId: isGiven(customer.quoteId) ? String(customer.quoteId) : undefined,
      customerId: isGiven(customer.customerId) ? String(customer.customerId) : undefined,
      items,
    },
  };
}

/** One plain-language line per applied build-up step, read straight off the engine trace. */
function costExplanation(line) {
  const trace = line.trace || {};
  const cc = trace.costCandidate;
  const parts = [];
  if (cc) {
    parts.push(`Base cost ${fmt2(cc.value)} ${cc.currency} from ${cc.source ? cc.source.system : '?'} (${cc.basis}${cc.selectedBy ? ', ' + cc.selectedBy : ''})`);
  }
  for (const s of trace.steps || []) {
    if (s.note && s.note.skipped) continue;
    if (s.type === 'BASE') continue;
    parts.push(`${s.id} +${fmt2(s.delta)}`);
  }
  const skipped = (trace.steps || []).filter((s) => s.note && s.note.skipped).map((s) => s.id);
  let text = parts.join('; ');
  if (line.status === 'PRICED') text += ` = ${fmt2(line.result.unitPrice)} ${line.result.currency}`;
  if (skipped.length) text += ` (not applied: ${skipped.join(', ')})`;
  if (trace.configVersion) text += ` [config ${trace.configVersion}]`;
  return text;
}

/**
 * Neutral pricing lines -> calculatedPriceList[] exactly as the ABSL parses it. Two
 * deliberate choices, both honest: (1) margin logic is not configured in the engine yet, so
 * the returned price is the incoming C4C price when one exists (never destroyed), else the
 * landed cost — explainPriceDesc says which; (2) a MISSING line returns costPlusUnitAmt "0"
 * (the ABSL's own "Cost not available" path) with the typed reason in explainCostDesc.
 */
function renderCalculatedPriceList(lines, meta) {
  return lines.map((line, i) => {
    const m = meta[i] || { lineId: '', itemLongNbr: line.partNumber, incomingPrice: '', priceCurrency: '' };
    const base = {
      lineId: m.lineId,
      itemLongNbr: m.itemLongNbr,
      isAgreedPriceExist: null,
      fromQty: '0',
      costAvailableFromQty: '0',
      transportationDays: '0',
      processingDays: '0',
      ccpMsg: '',
      messageCode: '',
      costFechedFrom: '',
    };

    if (line.status === 'PRICED') {
      const landed = String(line.result.unitPrice);
      const cc = line.trace && line.trace.costCandidate;
      const price = m.incomingPrice || landed;
      const gp = new Decimal(price).gt(0) ? new Decimal(price).minus(landed).div(price) : new Decimal(0);
      const system = cc && cc.source ? cc.source.system : '';
      return {
        ...base,
        costPlusUnitAmt: landed,
        c4cUnitPriceAmt: price,
        c4cPriceMultipliedAmt: price,
        gpamt: gp.toDecimalPlaces(4).toString(),
        salesQuantity: String(line.result.quantity),
        costCurrencyCode: line.result.currency,
        priceCurrencyCode: line.result.currency,
        costFechedFrom: system,
        // The ABSL's own convention: M1 = "Cost retrived from CCD (supplier cost)".
        messageCode: system === 'CCD' ? 'M1' : '',
        explainDesc: `Landed cost ${fmt2(landed)} ${line.result.currency}, cost source ${system || 'n/a'}.`,
        explainCostDesc: costExplanation(line),
        explainPriceDesc: m.incomingPrice
          ? `Price ${m.incomingPrice} kept from C4C — no margin rule configured in the pricing engine yet.`
          : 'No margin rule configured yet — price equals landed cost.',
        explainGPDesc: `Margin ${(Number(gp) * 100).toFixed(2)} % (price ${fmt2(price)} vs landed cost ${fmt2(landed)}).`,
      };
    }

    const reason = line.missing ? `${line.missing.reason}${line.missing.detail ? ' — ' + line.missing.detail : ''}` : line.status;
    return {
      ...base,
      costPlusUnitAmt: '0',
      c4cUnitPriceAmt: m.incomingPrice || '0',
      c4cPriceMultipliedAmt: m.incomingPrice || '0',
      gpamt: '0',
      salesQuantity: '',
      costCurrencyCode: '',
      priceCurrencyCode: m.priceCurrency || '',
      explainDesc: `No cost: ${reason}`,
      explainCostDesc: `Cost was not resolved: ${reason}`,
      explainPriceDesc: m.incomingPrice ? `Existing C4C price ${m.incomingPrice} left unchanged.` : '',
      explainGPDesc: '',
    };
  });
}

/**
 * getPricePoints: the quantity-break points for one part (the ABSL's getCostPoints and
 * getPricePoints item actions both call this shape). Points come from the part's
 * quantity-break table and any price lists carrying it — each point says which list it
 * came from (priceListCde), mirroring the ABSL's Source_ID.
 */
function buildPricePoints({ facts, partNumber, unitCode }) {
  const points = [];
  const breaks = (facts.qtyBreaks && facts.qtyBreaks[partNumber]) || [];
  for (const tier of breaks) {
    points.push({
      tssArticleNumber: partNumber,
      currencyCode: tier.currency || '',
      quantity: String(tier.minQty),
      unitCode: unitCode || '',
      price: String(tier.value),
      supplierMainCode: '',
      priceListCde: 'QTY_BREAK',
    });
  }
  const lists = facts.priceLists || {};
  for (const [kind, keyed] of [['SUPPLIER', lists.bySupplier || {}], ['CATEGORY', lists.byCategory || {}]]) {
    for (const [key, table] of Object.entries(keyed)) {
      for (const entry of table[partNumber] || []) {
        points.push({
          tssArticleNumber: partNumber,
          currencyCode: entry.currency || '',
          quantity: String(entry.minQty),
          unitCode: unitCode || '',
          price: String(entry.value),
          supplierMainCode: kind === 'SUPPLIER' ? key : '',
          priceListCde: `${kind}:${key}`,
        });
      }
    }
  }
  return points;
}

module.exports = { translateCustomerPriceListRequest, renderCalculatedPriceList, buildPricePoints };
