'use strict';

/**
 * Turns the pricing API's response into what an agent actually needs: a compact, honest
 * per-line outcome, and (on request) a readable calculation. No pricing math happens here —
 * every number is copied from the engine's result/trace; this only selects and words them.
 */

const NUMERIC = /^-?\d+(\.\d+)?$/;
const trim = (v) => (typeof v === 'string' && NUMERIC.test(v) && v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

/** Neutral item fields the API understands; anything else an agent sends is dropped, not guessed at. */
function toApiItem(item) {
  const out = { partNumber: item.partNumber, quantity: item.quantity };
  for (const k of ['supplier', 'supplierCountry', 'supplierExternalId', 'warehouse', 'ood', 'stockClass',
    'additionalCost', 'itemType', 'pricingType', 'productCategory', 'priceUnit', 'segment', 'components']) {
    if (item[k] !== undefined && item[k] !== null && item[k] !== '') out[k] = item[k];
  }
  if (item.marginPct !== undefined && item.marginPct !== null) out.margin = { marginPct: String(item.marginPct) };
  if (item.manualPrice !== undefined && item.manualPrice !== null) out.manualPrice = String(item.manualPrice);
  return out;
}

function costSource(trace) {
  const c = trace && trace.costCandidate;
  if (!c) return null;
  return {
    system: c.source && c.source.system,
    basis: c.basis,
    confidence: c.confidence,
    value: trim(c.value),
    currency: c.currency,
    selectedBy: c.selectedBy,
  };
}

function summarizeLine(line) {
  const base = { partNumber: line.partNumber, status: line.status };
  const t = line.trace || {};
  const kitParts = t.kit ? { kit: true, components: (t.components || []).map(summarizeLine) } : {};
  if (line.status !== 'PRICED') {
    return {
      ...base,
      ...kitParts,
      reason: (line.missing && line.missing.reason) || 'UNKNOWN',
      detail: (line.missing && line.missing.detail) || null,
      ...(line.missing && line.missing.componentPartNumber ? { componentPartNumber: line.missing.componentPartNumber, componentIssue: line.missing.componentIssue } : {}),
      stockClass: t.stockClass || null,
      hint: hintFor(line),
    };
  }
  const r = line.result || {};
  return {
    ...base,
    ...kitParts,
    quantity: r.quantity,
    currency: r.currency,
    // For COST_PLUS the engine's `unitPrice` IS the landed cost; an OPPORTUNITY carries it as `landedCost`.
    landedCost: trim(r.landedCost !== undefined ? r.landedCost : r.unitPrice),
    ...(r.sellingPrice !== undefined ? { sellingPrice: trim(r.sellingPrice), marginPct: trim(r.marginPct), priceBy: r.priceBy } : {}),
    priceUnit: r.priceUnit || 1,
    stockClass: t.stockClass || null,
    costSource: costSource(t),
    configVersion: t.configVersion || null,
    ...(Array.isArray(t.constraintPasses) && t.constraintPasses.length ? { constraints: t.constraintPasses } : {}),
  };
}

function hintFor(line) {
  const reason = line.missing && line.missing.reason;
  switch (reason) {
    case 'NO_CANDIDATES': return 'No cost was found for this part. Check the part number, region and (in live mode) that the cost source answers for it.';
    case 'STOCK_CLASS_UNRESOLVED': return 'Stock class could not be determined. Pass stockClass ("MTS" or "NonMTS") explicitly, or call get_item_attributes first.';
    case 'RATE_MISSING': return 'A charge rate this region needs is missing (usually freight/duty/tariff for the supplier × warehouse). Pass supplier and warehouse.';
    case 'AMOUNT_MISSING': return 'A fixed charge amount this region needs is missing.';
    case 'QUANTITY_INVALID': return 'Quantity must be a number greater than 0.';
    case 'SELECTED_COST_NOT_FOUND': return 'The requested cost candidate does not exist for this part. Omit selectedCostId to let the region\'s cost-source order choose.';
    case 'KIT_NOT_SUPPORTED_FOR_REGION': return 'Kits are only supported for AMERICAS and CHINA. Price the components as separate lines instead.';
    case 'KIT_COMPONENT_UNRESOLVED': return 'A component of the kit could not be priced; see componentIssue for which one and why. A kit is MISSING if any component is.';
    case 'KIT_CURRENCY_MISMATCH': return 'The kit\'s components price in different currencies; there is no FX conversion across components.';
    case 'FACT_INVALID': case 'COST_VALUE_INVALID': return 'A value in the data for this part is not a number; the detail names which one.';
    case 'PRICE_LIST_COST_NOT_FOUND': return 'No price-list cost matched. Pass supplier or productCategory for pricingType PRICE_LIST.';
    default: return null;
  }
}

function summarizeRun(body) {
  const lines = (body.items || []).map(summarizeLine);
  return {
    region: body.region && body.region.value,
    regionDerivedBy: body.region && body.region.derivedBy,
    configVersion: body.config && body.config.version,
    priceDate: body.priceDate,
    dataSource: body.api6Mode === 'recorded' ? 'DEMO_DATA' : (body.api6Mode || null),
    ...(body.costOnly ? { costOnly: true } : {}),
    priced: lines.filter((l) => l.status === 'PRICED').length,
    total: lines.length,
    lines,
    note: 'Amounts are per `priceUnit` pieces (e.g. priceUnit 100 = per 100 pieces). landedCost = cost + the region\'s configured add-ons; sellingPrice appears only when a margin or price was given or a predefined margin rule applies.',
  };
}

/** Plain-language calculation for one line, straight off the engine trace. */
function explainLine(line, body) {
  const t = line.trace || {};
  const out = [];
  out.push(`${line.partNumber} — ${line.status}${t.region ? ` — region ${t.region}` : ''}${t.configVersion ? `, config ${t.configVersion}` : ''}`);
  if (body && body.api6Mode === 'recorded') out.push('NOTE: costs come from recorded demo data, not the live gateway.');
  const c = t.costCandidate;
  if (c) out.push(`Cost used: ${trim(c.value)} ${c.currency || ''} per piece — ${c.source && c.source.system} (${c.basis}, ${c.confidence}), chosen by ${c.selectedBy}.`);
  if (t.stockClass) out.push(`Stock class: ${t.stockClass}.`);
  const steps = t.steps || [];
  steps.forEach((s, i) => {
    const n = s.note || {};
    if (s.skipped || (n.skipped)) { out.push(`${i + 1}. ${s.id} — not applied${n.when ? ` (condition not met: ${n.when})` : ''}`); return; }
    let how = '';
    if (s.type === 'FACTOR') how = ` = ${trim(n.rate)} × ${trim(n.basisAmount)}${n.basis ? ` (of ${n.basis.join(' + ')})` : ''}`;
    else if (s.type === 'PER_LINE') how = n.perQuantity ? ` (per-order amount ÷ quantity ${n.perQuantity})` : '';
    out.push(`${i + 1}. ${s.id} [${s.type}] +${trim(s.delta)}${how} → running total ${trim(s.runningTotal)}`);
  });
  if (line.status !== 'PRICED') {
    out.push(`Result: MISSING — ${(line.missing && line.missing.reason) || 'UNKNOWN'}${line.missing && line.missing.detail ? ` (${line.missing.detail})` : ''}.`);
    const h = hintFor(line); if (h) out.push(h);
  } else {
    const r = line.result;
    const unit = r.priceUnit || 1;
    out.push(`Result: landed cost ${trim(r.landedCost !== undefined ? r.landedCost : r.unitPrice)} ${r.currency} per ${unit} pc.`);
    if (r.sellingPrice !== undefined) out.push(`Selling price ${trim(r.sellingPrice)} ${r.currency} per ${unit} pc, margin ${trim(r.marginPct)} % (${r.priceBy}).`);
  }
  (t.constraintPasses || []).forEach((p) => out.push(`Rule applied: ${JSON.stringify(p)}`));
  return out.join('\n');
}

module.exports = { toApiItem, summarizeLine, summarizeRun, explainLine, hintFor };
