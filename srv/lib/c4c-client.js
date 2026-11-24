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

  // Entity model knobs — CONFIRMED against the real my352500 tenant (quote 235063, 2026-11-24):
  headerIdField: 'ID',
  itemProductField: 'ProductInternalID',
  itemParentField: 'ParentObjectID',
  collections: {
    QUOTE: { header: 'SalesQuoteCollection', item: 'SalesQuoteItemCollection' },
    OPPORTUNITY: { header: 'OpportunityCollection', item: 'OpportunityItemCollection' },
  },

  // READ side (fetching a quote/opportunity's items to fill the pricing grid) — CONFIRMED
  // against the real my352500 tenant (quote 235063, 2026-11-24): extension fields keep
  // their xbo names (typed ones flattened to <name>content/<name>currencyCode/unitCode),
  // standard fields use the c4codataapi spellings below. Still overridable via the
  // Connections field map / C4C_FIELD_MAP env.
  read: {
    headerAccount: 'BuyerPartyName',
    headerCurrency: 'CurrencyCode',
    itemId: 'ItemID',
    description: 'PROD_DESC', // 'Description' carries the product id on this tenant
    quantity: 'Quantity',
    quantityUnit: 'QuantityMeasureUnitCode',
    customerPartNumber: 'ZProductBuyerID',
    originOfData: 'OriginOfDataID',
    warehouse: 'WarehouseID',
    numberOfPicks: 'ZNumberOfPicks',
    leadTime: 'ZLeadTime',
    additionalCost: 'ZAddCost_KUT',
    supplier: '', // no supplier field on the quote item — it resolves via OOD/supplier master later
    productCategory: 'ProductCategoryID',
    priceBreak: 'PriceBreakIndicator_KUT',
    alternativeToLine: 'AlternativeToItemID',
    // Product master (Add-item type-ahead + blank-field enrichment). Confirmed against the
    // tenant's $metadata: entity set ProductCollection, Product.ID / .Description /
    // .UnitOfMeasureCode (ShortNumber and JDEMaterialNo_KUT also exist on it).
    productCollection: 'ProductCollection',
    // The product master is served by the full c4codata service (verified by the owner:
    // .../c4codata/ProductCollection?$filter=ID eq '...' works); the c4codataapi service
    // used for quotes answers HTTP 400 on it. Separate path so quotes are unaffected.
    productServicePath: '/sap/c4c/odata/v1/c4codata',
    productId: 'ID',
    productDescription: 'Description',
    productUom: 'UnitOfMeasureCode',
    // Per-sales-org product data (navigation ProductSales; its properties per the tenant's
    // $metadata): the raw ERP stock class lives here, NOT on the quote item.
    productSalesNav: 'ProductSales',
    productSalesOrg: 'SalesOrganisationID',
    productStockClass: 'StockClass',
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

  /** Shared gate for every C4C call: typed outcomes, never a half-configured attempt. */
  async function gate(objectId) {
    const destination = await resolveDestination(destinationName);
    if (!destination || !destination.url) {
      return { error: {
        status: 'C4C_NOT_CONFIGURED',
        message: `No C4C connection — set the C4C URL in the admin Connections tab (or the "${destinationName}" destination). Nothing was called.`,
      } };
    }
    if (!destination.username || !destination.password) {
      return { error: {
        status: 'C4C_CREDENTIALS_MISSING',
        message: 'C4C URL is set but the technical user is not — provide credentials via the BTP destination or the C4C_USERNAME / C4C_PASSWORD environment variables (never in config).',
      } };
    }
    if (!objectId) {
      return { error: { status: 'C4C_ERROR', message: 'objectId is required.' } };
    }
    return { destination };
  }

  /**
   * READ: fetch a quote/opportunity header + items from C4C to fill the pricing grid —
   * the "replace the Products tab" direction. Returns typed outcomes like writeBack:
   * { status:'OK', objectId, header:{account,currency}, items:[...] } with each item
   * carrying the grid's columns (partNumber, description, quantity, uom, customer part
   * number, origin of data, warehouse, picks, lead time, additional cost, supplier).
   */
  async function fetchObjectItems({ objectType, objectId }) {
    const kind = objectType === 'OPPORTUNITY' ? 'OPPORTUNITY' : 'QUOTE';
    const gated = await gate(objectId);
    if (gated.error) return gated.error;
    const destination = gated.destination;

    const root = destination.url.replace(/\/$/, '') + servicePath;
    const base = { ...authHeaders(destination), Accept: 'application/json' };
    const collections = fields.collections[kind];
    const r = fields.read;

    try {
      const headerRes = await fetchImpl(
        `${root}/${collections.header}?$filter=${fields.headerIdField} eq '${encodeURIComponent(objectId)}'`,
        { method: 'GET', headers: base },
      );
      if (!headerRes.ok) { return { status: 'C4C_ERROR', message: `C4C header lookup failed (HTTP ${headerRes.status}).` }; }
      const headerBody = await headerRes.json();
      const headerRows = (headerBody.d && headerBody.d.results) || [];
      if (headerRows.length === 0) { return { status: 'C4C_ERROR', message: `${kind} "${objectId}" not found in C4C.` }; }
      const headerRow = headerRows[0];

      const itemsRes = await fetchImpl(
        `${root}/${collections.item}?$filter=${fields.itemParentField} eq '${headerRow.ObjectID}'`,
        { method: 'GET', headers: base },
      );
      if (!itemsRes.ok) { return { status: 'C4C_ERROR', message: `C4C item lookup failed (HTTP ${itemsRes.status}).` }; }
      const itemsBody = await itemsRes.json();
      const rows = (itemsBody.d && itemsBody.d.results) || [];

      const val = (row, key) => (key && row[key] !== undefined && row[key] !== null ? String(row[key]) : '');
      return {
        status: 'OK',
        objectId,
        header: {
          account: val(headerRow, r.headerAccount) || null,
          currency: val(headerRow, r.headerCurrency) || null,
        },
        items: rows.map((row) => ({
          itemId: val(row, r.itemId),
          partNumber: val(row, fields.itemProductField),
          description: val(row, r.description),
          quantity: val(row, r.quantity),
          uom: val(row, r.quantityUnit),
          customerPartNumber: val(row, r.customerPartNumber),
          ood: val(row, r.originOfData),
          warehouse: val(row, r.warehouse),
          picks: val(row, r.numberOfPicks),
          leadTime: val(row, r.leadTime),
          additionalCost: val(row, r.additionalCost),
          supplier: val(row, r.supplier),
          productCategory: val(row, r.productCategory),
          priceBreak: row[r.priceBreak] === true || row[r.priceBreak] === 'true' || row[r.priceBreak] === 'X',
          alternativeToLine: val(row, r.alternativeToLine),
        })),
      };
    } catch (err) {
      return { status: 'C4C_ERROR', message: `C4C call failed: ${err.message}` };
    }
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
    const gated = await gate(objectId);
    if (gated.error) return gated.error;
    const destination = gated.destination;

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

  /**
   * Product-master type-ahead for the Add-item dialog: searches C4C materials by the typed
   * prefix. Same typed outcomes as every other C4C call; the caller decides what to do when
   * C4C isn't connected (srv falls back to the local recorded catalog, honestly labeled).
   */
  async function searchProducts({ query }) {
    const q = String(query || '').trim();
    const gated = await gate(q); // reuses the URL/credentials gate; q doubles as the non-empty check
    if (gated.error) return gated.error;
    const destination = gated.destination;

    const r = fields.read;
    const productPath = r.productServicePath || servicePath;
    const root = destination.url.replace(/\/$/, '') + productPath;
    try {
      const res = await fetchImpl(
        `${root}/${r.productCollection}?$filter=startswith(${r.productId},'${encodeURIComponent(q)}')&$top=10&$select=${r.productId},${r.productDescription}`,
        { method: 'GET', headers: { ...authHeaders(destination), Accept: 'application/json' } },
      );
      if (!res.ok) { return { status: 'C4C_ERROR', message: `C4C product search failed (HTTP ${res.status} on ${productPath}/${r.productCollection}).` }; }
      const body = await res.json();
      const rows = (body.d && body.d.results) || [];
      return {
        status: 'OK',
        source: 'C4C',
        products: rows.map((row) => ({
          id: row[r.productId] !== undefined && row[r.productId] !== null ? String(row[r.productId]) : '',
          description: row[r.productDescription] !== undefined && row[r.productDescription] !== null ? String(row[r.productDescription]) : '',
        })),
      };
    } catch (err) {
      return { status: 'C4C_ERROR', message: `C4C call failed: ${err.message}` };
    }
  }

  /**
   * Product-master details for a set of parts (fills blanks after a quote fetch or import —
   * description/base UoM today; supplier is NOT here: it lives in the custom OriginOfData
   * BO, which needs its own OData service name from the owner before we can read it).
   */
  async function fetchProductDetails({ partNumbers }) {
    const parts = [...new Set((partNumbers || []).map((p) => String(p || '').trim()).filter(Boolean))].slice(0, 20);
    if (parts.length === 0) return { status: 'OK', products: {} };
    const gated = await gate(parts[0]);
    if (gated.error) return gated.error;
    const destination = gated.destination;

    const r = fields.read;
    const productPath = r.productServicePath || servicePath;
    const root = destination.url.replace(/\/$/, '') + productPath;
    const filter = parts.map((p) => `${r.productId} eq '${encodeURIComponent(p)}'`).join(' or ');
    const base = `${root}/${r.productCollection}?$filter=${filter}&$top=${parts.length}`;
    const get = (url) => fetchImpl(url, { method: 'GET', headers: { ...authHeaders(destination), Accept: 'application/json' } });
    const str = (v) => (v !== undefined && v !== null ? String(v) : '');
    try {
      // With the sales navigation first (raw stock class per sales org); if the tenant
      // rejects the $expand, retry without it so description/UoM still fill in.
      let res = await get(`${base}&$expand=${r.productSalesNav}`);
      let expanded = res.ok;
      if (!res.ok) { res = await get(base); }
      if (!res.ok) { return { status: 'C4C_ERROR', message: `C4C product lookup failed (HTTP ${res.status} on ${productPath}/${r.productCollection}).` }; }
      const body = await res.json();
      const rows = (body.d && body.d.results) || [];
      const products = {};
      for (const row of rows) {
        const id = str(row[r.productId]);
        if (!id) continue;
        const nav = expanded ? row[r.productSalesNav] : null;
        const salesRows = Array.isArray(nav) ? nav : ((nav && nav.results) || []);
        products[id] = {
          description: str(row[r.productDescription]),
          uom: str(row[r.productUom]),
          sales: salesRows.map((sr) => ({ salesOrg: str(sr[r.productSalesOrg]), stockClassRaw: str(sr[r.productStockClass]) })),
        };
      }
      return { status: 'OK', products };
    } catch (err) {
      return { status: 'C4C_ERROR', message: `C4C call failed: ${err.message}` };
    }
  }

  /** For the admin "Connections" view: what this adapter would talk to, and whether a
   *  destination is actually configured — never the credentials themselves. */
  async function describe() {
    const destination = await resolveDestination(destinationName);
    return {
      destinationName,
      configured: !!(destination && destination.url && destination.username && destination.password),
      urlConfigured: !!(destination && destination.url),
      credentialsConfigured: !!(destination && destination.username && destination.password),
      url: destination && destination.url ? destination.url : null,
      servicePath,
      fieldMap: fields,
    };
  }

  return { writeBack, fetchObjectItems, searchProducts, fetchProductDetails, describe, fields };
}

module.exports = { createC4cClient, DEFAULT_FIELD_MAP, DEFAULT_SERVICE_PATH };
