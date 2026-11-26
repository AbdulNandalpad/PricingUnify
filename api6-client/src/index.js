const path = require('node:path');
const { createConnector } = require('./connector');
const authStrategies = require('./auth/strategies');
const { noAuth } = authStrategies;

/**
 * The single door to API6 (requirements §8): one call per pricing run, raw facts only —
 * API6 never pre-applies a markup, so everything this returns is exactly what engine-core's
 * `facts` argument expects. Defaults to recorded-payload mode (API6_MODE unset or
 * "recorded") — no live credentials are required until the app is actually pointed at a
 * real API6 endpoint (API6_MODE=live, API6_BASE_URL, and an auth strategy).
 */
/** WSO2/API6 endpoint per cost-source system — the configured cost access sequence drives
 *  WHICH of these get called and in what order (owner decision 2026-11-24: "the routing
 *  should happen based on the sequence defined... call different endpoints in WSO2").
 *  Integration config, overridable per deployment; an unlisted system falls back to
 *  `/costs/<system lowercased>`. Never pricing config — the sequence itself stays in
 *  region-config where it always was. */
const DEFAULT_COST_SOURCE_ENDPOINTS = {
  C4C: '/costs/c4c',
  ERP: '/costs/erp',
  CCD: '/costs/ccd',
  CCP: '/costs/ccp',
};
const { buildBiPriceRequest, parseBiPriceResponse, DEFAULT_REQUEST_MAPPING } = require('./bi-price-request');
const DEFAULT_BI_PRICE_LIST_ENDPOINT = '/core/price/rest/v1/getPriceList';
const DEFAULT_PRICE_LIST_ENDPOINT = '/costs/price-list';
// Kit (BOM) components. Two routing modes, both config (owner decision 2026-11-26: no orchestration logic
// in middleware, so individual endpoints must be possible; the COMMON one is used first):
//  - COMMON: one API6 endpoint for every Origin of Data; API6 itself routes to the right ERP by `originOfData`.
//  - INDIVIDUAL: `kitEndpoints[ood]` points one OOD straight at its own endpoint. An OOD with an entry uses
//    it; every other OOD keeps using the common one, so switching OOD by OOD is a config change only.
const DEFAULT_KIT_ENDPOINT = '/core/item/rest/v1/getKitComponents';
const DEFAULT_KIT_REQUESTOR_ID = 'FS';
const DEFAULT_KIT_ENDPOINTS = {};

// "0000000020" -> 20. Anything that is not a plain non-negative number is passed through unchanged so the
// kernel answers its typed QUANTITY_INVALID instead of us guessing.
function parseKitQuantity(q) {
  if (typeof q === 'number') return q;
  const t = String(q === undefined || q === null ? '' : q).trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return q;
}

function createApi6Client({
  mode = process.env.API6_MODE || 'recorded',
  baseUrl = process.env.API6_BASE_URL,
  auth = noAuth(),
  recordedDir = path.join(__dirname, '..', 'recorded'),
  costSourceEndpoints = {},
  priceListEndpoint = DEFAULT_PRICE_LIST_ENDPOINT,
  kitEndpoints = {},
  kitEndpoint = DEFAULT_KIT_ENDPOINT,
  kitRequestorId = DEFAULT_KIT_REQUESTOR_ID,
  biPriceListEndpoint = DEFAULT_BI_PRICE_LIST_ENDPOINT,
  requestMapping = null,
  fetchImpl,
} = {}) {
  const connector = createConnector({ mode, baseUrl, authStrategy: auth, recordedDir, ...(fetchImpl ? { fetchImpl } : {}) });
  const endpoints = { ...DEFAULT_COST_SOURCE_ENDPOINTS, ...costSourceEndpoints };
  const endpointFor = (system) => endpoints[system] || `/costs/${String(system).toLowerCase()}`;
  const kitEndpoints_ = { ...DEFAULT_KIT_ENDPOINTS, ...kitEndpoints };
  const kitRouteFor = (ood) => (kitEndpoints_[ood]
    ? { endpoint: kitEndpoints_[ood], routing: 'INDIVIDUAL' }
    : { endpoint: kitEndpoint, routing: 'COMMON' });

  return {
    mode: connector.mode,
    authType: connector.authType,
    // Exposed for the admin "Connections" view — which endpoint each cost source routes to.
    costSourceEndpoints: endpoints,
    priceListEndpoint,
    kitEndpoints: kitEndpoints_,
    kitEndpoint,
    kitRequestorId,
    biPriceListEndpoint,

    /**
     * The BI price endpoint (e.g. https://apimqua.tss.trelleborg.com/core/price/rest/v1/getPriceList):
     * takes the C4C-shaped body (`customer{}` + `item[]`) and answers `calculatedPriceList[]`. The
     * CPI step that used to sit in front of it is replaced by `buildBiPriceRequest` (its rules are
     * the configurable `requestMapping`). Live mode = one authenticated POST; recorded mode makes
     * no outbound call and says so (`RECORDED_MODE`, with the request that WOULD have been sent).
     * Never throws on an API6 fault: a non-SUCCESS answer is `{status:'FAILED', message}`.
     */
    async fetchBiPriceList(c4cBody) {
      const { body, context } = buildBiPriceRequest(c4cBody, requestMapping);
      if (connector.mode === 'recorded') {
        return { status: 'RECORDED_MODE', endpoint: biPriceListEndpoint, request: body, context, lines: [] };
      }
      try {
        const res = await connector.call(null, { method: 'POST', path: biPriceListEndpoint, body });
        return { endpoint: biPriceListEndpoint, context, request: body, raw: res, ...parseBiPriceResponse(res) };
      } catch (err) {
        return { status: 'FAILED', endpoint: biPriceListEndpoint, context, request: body, message: err.message, lines: [] };
      }
    },

    /**
     * TEMPORARY cost source (owner: "we use it temporarily, later API6 creates endpoints just to
     * fetch costs — right now it does the calculation"). The BI endpoint calculates a landed cost
     * itself; our engine does that calculation, so taking its landed cost would mark the cost up
     * twice. This asks for the COST ONLY: every line is sent with Additional Cost flag "0" and
     * zero picks, which in the real sample means "hand the cost back 1:1" (no markup, no landed
     * factor, no pick). One cost candidate per lineId comes back; its source is C4C when the BI
     * says the cost was handed over from C4C, CCD for message code M1 (the C4C script's own
     * convention), otherwise the neutral BI_PRICE_LIST so the trace never claims a system it
     * cannot prove. ASSUMPTION still to be verified live with a flag-0 call: costPlusUnitAmt
     * equals the raw cost found. Goes away when the cost-only endpoints exist.
     */
    async fetchBiCosts(c4cBody) {
      const forced = JSON.parse(JSON.stringify(c4cBody || {}));
      const arr = Array.isArray(forced.item) ? forced.item : (forced.item ? [forced.item] : []);
      for (const it of arr) { it.useCostPlusFlag = '0'; it.c4cPickCount = 0; }
      forced.item = arr;
      const res = await this.fetchBiPriceList(forced);
      if (res.status !== 'OK') return { status: res.status, endpoint: res.endpoint, message: res.message, request: res.request, candidates: {} };
      const candidates = {};
      for (const l of res.lines) {
        const value = Number(l.costPlusUnitAmt);
        if (!Number.isFinite(value) || value <= 0) {
          candidates[l.lineId] = { found: false, note: l.ccpMessage || l.explainCost || 'no cost returned', costAvailableFromQty: l.costAvailableFromQty };
          continue;
        }
        const fromC4c = /c4c/i.test(l.costFetchedFrom);
        const ccd = l.messageCode === 'M1';
        candidates[l.lineId] = {
          found: true,
          value: l.costPlusUnitAmt,
          currency: l.costCurrencyCode,
          basis: fromC4c ? 'MANUAL' : 'SUPPLIER_CATALOG',
          source: { system: fromC4c ? 'C4C' : (ccd ? 'CCD' : 'BI_PRICE_LIST'), table: 'getPriceList', field: 'costPlusUnitAmt', key: `BI_${l.lineId}` },
          confidence: 'EXACT',
          fetchedFrom: l.costFetchedFrom,
          fromQty: l.fromQty,
          costAvailableFromQty: l.costAvailableFromQty,
        };
      }
      return { status: 'OK', endpoint: res.endpoint, candidates, request: res.request, raw: res.raw };
    },

    /** Returns { costs, elements, fx } shaped exactly like engine-core's `facts` — quantity
     *  breaks are the engine's problem (requirements §8), so `items` here is only used to
     *  pick/validate the recorded scenario, never to vary the call itself. */
    async getPricingFacts({ region, salesOrg, items, scenario }) {
      const recordedScenario = scenario || `${region.toLowerCase()}-default`;
      return connector.call(recordedScenario, {
        method: 'POST',
        path: '/pricing-facts',
        body: { region, salesOrg, items },
      });
    },

    /**
     * KIT / BOM explosion — API6 getKitComponents. Request (real contract):
     *   { tssArticleNumber, originOfData, warehouseCode, requestorId }   (requestorId default 'FS')
     * Answer: { status:{statusCode, faultMessage[]}, kitComponentList:{ itemKitComonent:[
     *   { tssArticleNumber, itemShortNumber, quantity:"0000000020", usage:"S"|"O" } ] } }
     * (sic: the real field is spelled `itemKitComonent`; the correctly spelled `itemKitComponent` is accepted too).
     * Routing is config: the COMMON endpoint (API6 routes to the ERP by originOfData) unless
     * `kitEndpoints[ood]` names an INDIVIDUAL one (assumed to speak the same contract). Components are
     * quantities PER ONE KIT, as the BOM holds them (zero-padding stripped); scaling by the ordered kit
     * quantity is the caller's job, as in SAP. `usage` and `itemShortNumber` are carried through untouched.
     *
     * Returns { status: 'OK'|'NOT_FOUND'|'FAILED', endpoint, routing, ood, request, components, message? }.
     * Never throws on an API6/ERP fault and never invents components. Recorded mode replays
     * recorded/kits-default.json ({ <ood>: { <partNumber>: <raw getKitComponents answer> } }), no call made.
     */
    async fetchKitComponents({ ood, partNumber, warehouse, scenario }) {
      const { endpoint, routing } = kitRouteFor(ood);
      const request = {
        tssArticleNumber: String(partNumber),
        originOfData: String(ood),
        ...(warehouse ? { warehouseCode: String(warehouse) } : {}),
        requestorId: kitRequestorId,
      };
      const base = { endpoint, routing, ood, request };
      try {
        let res;
        if (connector.mode === 'recorded') {
          const payload = await connector.call(scenario || 'kits-default');
          res = payload && payload[ood] && payload[ood][partNumber];
          if (!res) return { status: 'NOT_FOUND', ...base, components: [], message: `No recorded kit for ${partNumber} @ ${ood}.` };
        } else {
          res = await connector.call(null, { method: 'POST', path: endpoint, body: request });
        }
        const st = res && res.status;
        const code = st && typeof st === 'object' ? st.statusCode : st;
        if (code && String(code).toUpperCase() !== 'SUCCESS') {
          const faults = st && Array.isArray(st.faultMessage) ? st.faultMessage.filter(Boolean).join('; ') : '';
          return { status: 'FAILED', ...base, components: [], message: `API6 answered ${code}${faults ? `: ${faults}` : ''}` };
        }
        const list = (res && res.kitComponentList) || {};
        const rows = list.itemKitComonent || list.itemKitComponent || [];
        const components = (Array.isArray(rows) ? rows : [rows])
          .filter((c) => c && c.tssArticleNumber)
          .map((c) => ({
            partNumber: String(c.tssArticleNumber),
            quantity: parseKitQuantity(c.quantity),
            ...(c.usage ? { usage: String(c.usage) } : {}),
            ...(c.itemShortNumber !== undefined && c.itemShortNumber !== null ? { itemShortNumber: c.itemShortNumber } : {}),
          }));
        if (components.length === 0) return { status: 'NOT_FOUND', ...base, components: [], message: `No components returned for ${partNumber} from the ${routing.toLowerCase()} kit endpoint (${ood}).` };
        return { status: 'OK', ...base, components };
      } catch (err) {
        return { status: 'FAILED', ...base, components: [], message: err.message };
      }
    },

    /**
     * Walks the given cost access sequence, calling each source system's own WSO2 endpoint in
     * order, and stops at the first system that returns a cost candidate. Returns
     * { candidates, routing } where routing records every call made ({system, endpoint,
     * found}) so the trace can show the walk — never a silent fallback. In recorded mode each
     * "endpoint call" is simulated faithfully by filtering the region scenario's candidates to
     * that one system (exactly what the per-source endpoint would return); in live mode each
     * system is a real HTTP call to its configured endpoint.
     */
    async fetchCostsBySequence({ region, salesOrg, partNumber, quantity, sequence, scenario }) {
      const recordedScenario = scenario || `${region.toLowerCase()}-default`;
      const routing = [];
      const candidates = [];
      for (const system of sequence) {
        const endpoint = endpointFor(system);
        let sourceCandidates;
        if (connector.mode === 'recorded') {
          const payload = await connector.call(recordedScenario);
          const all = (payload.costs && payload.costs[partNumber] && payload.costs[partNumber].candidates) || [];
          sourceCandidates = all.filter((c) => c.source && c.source.system === system);
        } else {
          const res = await connector.call(recordedScenario, {
            method: 'POST',
            path: endpoint,
            body: { region, salesOrg, partNumber, quantity },
          });
          sourceCandidates = (res && res.candidates) || [];
        }
        routing.push({ system, endpoint, found: sourceCandidates.length });
        candidates.push(...sourceCandidates);
        if (sourceCandidates.length > 0) break;
      }
      return { candidates, routing };
    },

    /**
     * PRICE_LIST pricing type's cost lookup (owner decision 2026-11-24): a price list in TSS
     * carries COSTS, keyed by supplier first, else by product category — the normal build-up
     * (markup etc.) still applies on top afterward. Returns { entry, matchedBy, endpoint,
     * tried }: `entry` is the matching qty-break tier (or null), `matchedBy` says which key
     * won ('SUPPLIER:<id>' | 'CATEGORY:<id>'), `tried` lists every key attempted so a miss is
     * fully explained. In recorded mode the lookup reads the region scenario's `priceLists`
     * section (simulating what the WSO2 price-list endpoint returns for the given key, qty
     * and date); in live mode it is one call to the configured price-list endpoint.
     */
    async fetchPriceListCost({ region, salesOrg, partNumber, supplier, productCategory, quantity, priceDate, scenario }) {
      if (connector.mode !== 'recorded') {
        const res = await connector.call(null, {
          method: 'POST',
          path: priceListEndpoint,
          body: { region, salesOrg, partNumber, supplier, productCategory, quantity, priceDate },
        });
        return { endpoint: priceListEndpoint, ...res };
      }

      const payload = await connector.call(scenario || `${region.toLowerCase()}-default`);
      const lists = payload.priceLists || {};
      const lookups = [];
      if (supplier) lookups.push({ matchedBy: `SUPPLIER:${supplier}`, table: lists.bySupplier && lists.bySupplier[supplier] });
      if (productCategory) lookups.push({ matchedBy: `CATEGORY:${productCategory}`, table: lists.byCategory && lists.byCategory[productCategory] });

      const tried = [];
      const qty = Number(quantity);
      for (const { matchedBy, table } of lookups) {
        tried.push(matchedBy);
        const entries = (table && table[partNumber]) || [];
        const effective = entries.filter(
          (e) => (!e.validFrom || !priceDate || e.validFrom <= priceDate) && (!e.validTo || !priceDate || priceDate <= e.validTo),
        );
        const tier = effective
          .filter((e) => Number(e.minQty) <= qty)
          .sort((a, b) => Number(b.minQty) - Number(a.minQty))[0];
        if (tier) return { entry: tier, matchedBy, endpoint: priceListEndpoint, tried };
      }
      return { entry: null, matchedBy: null, endpoint: priceListEndpoint, tried };
    },
  };
}

module.exports = { createApi6Client, createConnector, buildBiPriceRequest, parseBiPriceResponse, DEFAULT_REQUEST_MAPPING, ...authStrategies };
