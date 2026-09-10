const cds = require('@sap/cds');

const { SELECT, INSERT } = cds.ql;
const ENTITY = 'tss.pricing.PricingDocuments';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * PricingDocuments (ARCHITECTURE_V2 §4.1): one row per `price` call — who asked (always the
 * token's user, never the payload), for which host object, under which config versions, the
 * payload exactly as received (so `simulate` can replay it) and the full result with every
 * line's trace. The "why" behind a price that reached a customer.
 */
async function storePricingDocument({ requestedBy, payload, response }) {
  const ID = cds.utils.uuid();
  await cds.db.run(INSERT.into(ENTITY).entries({
    ID,
    requestedBy,
    hostSystem: response.hostSystem || null,
    hostObjectType: response.hostObjectType || null,
    hostObjectId: response.hostObjectId || null,
    purpose: response.purpose || null,
    region: response.region && response.region.value,
    salesOrg: response.config && response.config.salesOrg,
    priceDate: response.priceDate,
    configVersions: JSON.stringify(response.config),
    request: JSON.stringify(payload),
    result: JSON.stringify({ items: response.items, region: response.region, party: response.party }),
    createdAt: new Date().toISOString(),
  }));
  return ID;
}

async function getPricingDocument(id) {
  const row = await cds.db.run(SELECT.one.from(ENTITY).where({ ID: id }));
  return row ? inflate(row) : null;
}

async function listPricingDocuments({ hostObjectId, from, to, limit } = {}) {
  const q = SELECT.from(ENTITY)
    .columns('ID', 'requestedBy', 'hostSystem', 'hostObjectType', 'hostObjectId', 'purpose', 'region', 'salesOrg', 'priceDate', 'configVersions', 'createdAt')
    .orderBy('createdAt desc')
    .limit(Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const where = {};
  if (hostObjectId) where.hostObjectId = hostObjectId;
  if (Object.keys(where).length) q.where(where);
  if (from) q.where('createdAt >=', `${from}T00:00:00.000Z`);
  if (to) q.where('createdAt <=', `${to}T23:59:59.999Z`);
  const rows = await cds.db.run(q);
  return rows.map((r) => ({ ...r, configVersions: parse(r.configVersions) }));
}

function inflate(row) {
  return {
    ...row,
    configVersions: parse(row.configVersions),
    request: parse(row.request),
    result: parse(row.result),
  };
}

function parse(s) {
  return typeof s === 'string' ? JSON.parse(s) : s;
}

module.exports = { storePricingDocument, getPricingDocument, listPricingDocuments, ENTITY };
