/**
 * C4C write-back adapter (Phase 5 of the C4C rework). Lives in srv — NEVER in engine-core
 * (the kernel does no I/O). Talks to C4C's OData API through the BTP destination
 * `C4C_ODATA` (a technical user maintained in the destination, not end-user credentials).
 *
 * What gets written (owner spec 2026-11-24):
 *  - QUOTE items: cost, landed cost, price, margin, pricing type.
 *  - OPPORTUNITY items: the cost fields only — price/margin are NEVER written for an
 *    opportunity, enforced here regardless of what a caller sends.
 *  - Header, both object types: ExternallyPriced_SDK=true, PricedBy_SDK=<logged-in user>,
 *    PricedOn_SDK=<timestamp> (these three names come from the owner's spec).
 *
 * Concurrency: every item PATCH carries If-Match with the ETag read in the same run; a 412
 * comes back as the typed C4C_CONFLICT outcome ("Object changed in C4C, reload") — never a
 * blind overwrite.
 *
 * FIELD/PATH NAMES: the owner's spec says not to invent C4C field names. The three _SDK
 * audit fields above are the spec's own. Everything else (item cost/price field names,
 * service path, collection names, filter fields) is CONFIGURATION with placeholder
 * defaults marked TO-CONFIRM below — correcting them when the owner supplies the real
 * names is a `C4C_FIELD_MAP` / `C4C_SERVICE_PATH` env change, not a code change.
 */

const DEFAULT_SERVICE_PATH = '/sap/c4c/odata/v1/c4codataapi';

const DEFAULT_FIELD_MAP = {
  // From the owner's spec — real names:
  externallyPriced: 'ExternallyPriced_SDK',
  pricedBy: 'PricedBy_SDK',
  pricedOn: 'PricedOn_SDK',

  // TO-CONFIRM placeholders (owner to supply the exact C4C item field names; override via
  // the C4C_FIELD_MAP env variable, JSON-merged over these):
  cost: 'Cost_SDK',
  landedCost: 'LandedCost_SDK',
  price: 'Price_SDK',
  marginPct: 'MarginPercent_SDK',
  pricingType: 'PricingType_SDK',

  // Entity model knobs (same TO-CONFIRM status):
  headerIdField: 'ID',
  itemProductField: 'ProductID',
  itemParentField: 'ParentObjectID',
  collections: {
    QUOTE: { header: 'SalesQuoteCollection', item: 'SalesQuoteItemCollection' },
    OPPORTUNITY: { header: 'OpportunityCollection', item: 'OpportunityItemCollection' },
  },
};

/** Default destination resolver: the CF `destinations` env convention
 *  ('[{"name":"C4C_ODATA","url":"...","username":"...","password":"..."}]'). A full BTP
 *  Destination-service lookup can be injected via resolveDestination without touching this
 *  file. Returns null when nothing is configured — the adapter then answers with the typed
 *  C4C_NOT_CONFIGURED status instead of failing or faking a write. */
function envDestinationResolver(name) {
  try {
    const all = JSON.parse(process.env.destinations || '[]');
    return all.find((d) => d.name === name) || null;
  } catch {
    return null;
  }
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? deepMerge(base[key] || {}, value) : value;
  }
  return out;
}

function createC4cClient({
  destinationName = 'C4C_ODATA',
  resolveDestination = envDestinationResolver,
  servicePath = process.env.C4C_SERVICE_PATH || DEFAULT_SERVICE_PATH,
  fieldMap,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  let envMap = {};
  try { envMap = JSON.parse(process.env.C4C_FIELD_MAP || '{}'); } catch { envMap = {}; }
  const fields = deepMerge(deepMerge(DEFAULT_FIELD_MAP, envMap), fieldMap || {});

  function authHeaders(destination) {
    const token = Buffer.from(`${destination.username}:${destination.password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }

  /**
   * Writes one pricing run's results back to the C4C host object.
   * items: [{ partNumber, cost, landedCost, price, marginPct, pricingType, currency }]
   * Returns one of the typed outcomes:
   *   { status: 'OK', written, objectId }
   *   { status: 'C4C_NOT_CONFIGURED', message }
   *   { status: 'C4C_CONFLICT', message, partNumbers }     // ETag mismatch — reload in C4C
   *   { status: 'C4C_ERROR', message, detail? }
   */
  async function writeBack({ objectType, objectId, items, user }) {
    const kind = objectType === 'OPPORTUNITY' ? 'OPPORTUNITY' : 'QUOTE';
    const destination = await resolveDestination(destinationName);
    if (!destination || !destination.url) {
      return {
        status: 'C4C_NOT_CONFIGURED',
        message: `BTP destination "${destinationName}" is not configured — nothing was written to C4C. ` +
          'Maintain the destination (technical user) and, when the owner confirms the real C4C field names, the C4C_FIELD_MAP env.',
      };
    }
    if (!objectId) {
      return { status: 'C4C_ERROR', message: 'objectId is required to write back to C4C.' };
    }

    const root = destination.url.replace(/\/$/, '') + servicePath;
    const base = { ...authHeaders(destination), Accept: 'application/json' };
    const collections = fields.collections[kind];

    async function call(method, url, { headers = {}, body } = {}) {
      const res = await fetchImpl(url, {
        method,
        headers: { ...base, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return res;
    }

    try {
      // 1. CSRF token (C4C OData requires one for modifying calls).
      const tokenRes = await call('GET', `${root}/`, { headers: { 'x-csrf-token': 'fetch' } });
      const csrf = tokenRes.headers.get('x-csrf-token') || '';

      // 2. Resolve the header by its visible ID -> internal ObjectID.
      const headerRes = await call('GET',
        `${root}/${collections.header}?$filter=${fields.headerIdField} eq '${encodeURIComponent(objectId)}'&$select=ObjectID`);
      if (!headerRes.ok) { return { status: 'C4C_ERROR', message: `C4C header lookup failed (HTTP ${headerRes.status}).` }; }
      const headerBody = await headerRes.json();
      const headerRows = (headerBody.d && headerBody.d.results) || [];
      if (headerRows.length === 0) {
        return { status: 'C4C_ERROR', message: `${kind} "${objectId}" not found in C4C.` };
      }
      const headerObjectId = headerRows[0].ObjectID;
      const headerEtag = (headerRows[0].__metadata && headerRows[0].__metadata.etag) || null;

      // 3. Read the items (ObjectID + product + ETag each).
      const itemsRes = await call('GET',
        `${root}/${collections.item}?$filter=${fields.itemParentField} eq '${headerObjectId}'`);
      if (!itemsRes.ok) { return { status: 'C4C_ERROR', message: `C4C item lookup failed (HTTP ${itemsRes.status}).` }; }
      const itemsBody = await itemsRes.json();
      const c4cItems = (itemsBody.d && itemsBody.d.results) || [];
      const byProduct = new Map(c4cItems.map((it) => [String(it[fields.itemProductField]), it]));

      // 4. PATCH each priced line's item, ETag-guarded.
      const conflicts = [];
      let written = 0;
      for (const line of items) {
        const target = byProduct.get(String(line.partNumber));
        if (!target) {
          return { status: 'C4C_ERROR', message: `Product "${line.partNumber}" is not an item of ${kind} "${objectId}" in C4C.` };
        }
        const body = {
          [fields.cost]: line.cost !== undefined && line.cost !== '' ? String(line.cost) : undefined,
          [fields.landedCost]: line.landedCost !== undefined && line.landedCost !== '' ? String(line.landedCost) : undefined,
          [fields.pricingType]: line.pricingType || undefined,
        };
        // OPPORTUNITY never gets a price or margin — enforced here, not trusted from the caller.
        if (kind === 'QUOTE') {
          if (line.price !== undefined && line.price !== '') { body[fields.price] = String(line.price); }
          if (line.marginPct !== undefined && line.marginPct !== '') { body[fields.marginPct] = String(line.marginPct); }
        }
        Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

        const etag = (target.__metadata && target.__metadata.etag) || null;
        const patchRes = await call('PATCH', `${root}/${collections.item}('${target.ObjectID}')`, {
          headers: { 'x-csrf-token': csrf, ...(etag ? { 'If-Match': etag } : {}) },
          body,
        });
        if (patchRes.status === 412) { conflicts.push(line.partNumber); continue; }
        if (!patchRes.ok && patchRes.status !== 204) {
          return { status: 'C4C_ERROR', message: `C4C rejected the item update for "${line.partNumber}" (HTTP ${patchRes.status}).` };
        }
        written++;
      }

      if (conflicts.length > 0) {
        return { status: 'C4C_CONFLICT', message: 'Object changed in C4C, reload.', partNumbers: conflicts };
      }

      // 5. Header audit flags — the three spec-given _SDK fields, on both object types.
      const auditRes = await call('PATCH', `${root}/${collections.header}('${headerObjectId}')`, {
        headers: { 'x-csrf-token': csrf, ...(headerEtag ? { 'If-Match': headerEtag } : {}) },
        body: {
          [fields.externallyPriced]: true,
          [fields.pricedBy]: user || 'unknown',
          [fields.pricedOn]: now().toISOString(),
        },
      });
      if (auditRes.status === 412) {
        return { status: 'C4C_CONFLICT', message: 'Object changed in C4C, reload.', partNumbers: [] };
      }
      if (!auditRes.ok && auditRes.status !== 204) {
        return { status: 'C4C_ERROR', message: `C4C rejected the header audit update (HTTP ${auditRes.status}).` };
      }

      return { status: 'OK', written, objectId };
    } catch (err) {
      return { status: 'C4C_ERROR', message: `C4C call failed: ${err.message}` };
    }
  }

  return { writeBack, fields };
}

module.exports = { createC4cClient, DEFAULT_FIELD_MAP, DEFAULT_SERVICE_PATH };
