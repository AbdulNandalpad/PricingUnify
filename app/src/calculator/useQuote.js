import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api.js';
import { DEFAULT_ROWS, newComponent, newRow, rowToItem, toPricingItems } from '../batch.js';
import { clone, todayIso } from '../format.js';

/** Seeded customers (party-config keys). A `listKeys`-style endpoint is not in §4.3, so the
 *  picker starts from these ids and reads each one's party-config for tier/country/ood. */
export const CUSTOMER_IDS = ['CUST-DE-001', 'CUST-DE-007', 'CUST-US-002', 'CUST-CN-003', 'CUST-IN-004'];
export const REGIONS = ['EUROPE', 'CHINA', 'INDIA', 'AMERICAS'];
export const QUOTE_ID = 'Q-2026-01847';

const signatureOf = (row) => JSON.stringify(rowToItem(row));

/** All calculator state, owned by App so Go live can simulate the same lines and the top bar
 *  can show the customer's entity. Nothing here computes a price — every number comes from
 *  `POST /rest/pricing/price`. */
export function useQuote({ user, ready }) {
  const [customerId, setCustomerId] = useState(CUSTOMER_IDS[0]);
  const [customers, setCustomers] = useState({});
  const [region, setRegion] = useState('EUROPE');
  const [route, setRoute] = useState(null);
  const [priceDate, setPriceDate] = useState(todayIso());
  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [results, setResults] = useState(null); // { byRowId, documentId, config, region, entityLabel, priceDate }
  const [pricing, setPricing] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [regionConfig, setRegionConfig] = useState(null);
  const [knownParts, setKnownParts] = useState({});
  const regionTouched = useRef(false);

  // customers: one party-config read per seeded id
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    Promise.all(CUSTOMER_IDS.map((id) => api.getEffective('party-config', id, priceDate).then((doc) => [id, doc]).catch(() => [id, null])))
      .then((pairs) => { if (!cancelled) setCustomers(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [ready, priceDate, user]);

  // region from the customer's data origin (editable afterwards)
  const party = customers[customerId] || null;
  useEffect(() => {
    if (!ready || !party?.customerOod) return;
    let cancelled = false;
    api.getEffective('region-route', api.docKey('region-route', { ood: party.customerOod, salesOrg: '*' }), priceDate)
      .then((r) => { if (cancelled) return; setRoute(r); if (!regionTouched.current && r?.region) setRegion(r.region); })
      .catch(() => { if (!cancelled) setRoute(null); });
    return () => { cancelled = true; };
  }, [ready, party?.customerOod, priceDate]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    api.listSuppliers(priceDate).then((res) => { if (!cancelled) setSuppliers(api.asList(res, 'suppliers')); }).catch(() => {});
    return () => { cancelled = true; };
  }, [ready, priceDate, user]);

  useEffect(() => {
    if (!ready || !region) return;
    let cancelled = false;
    api.getEffective('region-config', api.docKey('region-config', { region }), priceDate)
      .then((doc) => { if (!cancelled) setRegionConfig(doc); })
      .catch(() => { if (!cancelled) setRegionConfig(null); });
    return () => { cancelled = true; };
  }, [ready, region, priceDate, user]);

  const selectCustomer = useCallback((id) => { regionTouched.current = false; setCustomerId(id); }, []);
  const selectRegion = useCallback((r) => { regionTouched.current = true; setRegion(r); }, []);

  /* ── rows ─────────────────────────────────────────────────────────────── */
  const updateRow = useCallback((id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r))), []);
  const removeRow = useCallback((id) => setRows((rs) => rs.filter((r) => r.id !== id)), []);
  const addRow = useCallback(() => setRows((rs) => [...rs, newRow()]), []);
  const addRows = useCallback((more) => setRows((rs) => [...rs, ...more]), []);
  const toggleKit = useCallback((id) => updateRow(id, (r) => ({ kitOpen: !r.kitOpen, components: !r.kitOpen && r.components.length === 0 ? [newComponent()] : r.components })), [updateRow]);
  const updateComponent = useCallback((id, compId, patch) => updateRow(id, (r) => ({ components: r.components.map((c) => (c.id === compId ? { ...c, ...patch } : c)) })), [updateRow]);
  const addComponent = useCallback((id) => updateRow(id, (r) => ({ components: [...r.components, newComponent()] })), [updateRow]);
  const removeComponent = useCallback((id, compId) => updateRow(id, (r) => ({ components: r.components.filter((c) => c.id !== compId) })), [updateRow]);

  const context = useMemo(() => ({
    context: { hostSystem: 'APP', hostObjectType: 'QUOTE', hostObjectId: QUOTE_ID, purpose: 'INDICATIVE' },
    party: { customerId, salesOrg: party?.territory || undefined },
    customerId,
    region,
    salesOrg: party?.territory || undefined,
    priceDate,
  }), [customerId, party?.territory, region, priceDate]);

  /* ── backend calls ────────────────────────────────────────────────────── */
  const priceAll = useCallback(async (rowsToPrice = rows) => {
    setError(null); setNote(null);
    const sent = rowsToPrice.filter((r) => r.partNumber.trim());
    const items = toPricingItems(rowsToPrice);
    if (!items.length) { setError(new Error('Add at least one part number.')); return null; }
    setPricing(true);
    try {
      const res = await api.price({ ...context, items });
      // pricedRowIds zip: items[] comes back in submitted order; blank rows were dropped.
      const byRowId = {};
      sent.forEach((r, i) => { byRowId[r.id] = { ...res.items[i], documentId: res.documentId }; });
      setRows((rs) => rs.map((r) => (byRowId[r.id] ? { ...r, pricedSignature: signatureOf(r) } : r)));
      setResults({ byRowId, documentId: res.documentId, config: res.config, region: typeof res.region === 'object' ? res.region?.value : res.region, entityLabel: res.entityLabel || res.region?.entityLabel || null, priceDate: res.priceDate, requestedBy: res.requestedBy });
      return res;
    } catch (e) { setError(e); return null; } finally { setPricing(false); }
  }, [rows, context]);

  /** Re-price ONE line (margin slider): a fresh `price` call for that item only, merged back. */
  const repriceLine = useCallback(async (rowId, patch) => {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    const next = { ...row, ...patch };
    setRows((rs) => rs.map((r) => (r.id === rowId ? next : r)));
    try {
      const res = await api.price({ ...context, items: [rowToItem(next)] });
      setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, pricedSignature: signatureOf(next) } : r)));
      setResults((prev) => ({ ...(prev || {}), byRowId: { ...(prev?.byRowId || {}), [rowId]: { ...res.items[0], documentId: res.documentId } } }));
    } catch (e) { setError(e); }
  }, [rows, context]);

  const fetchAttributes = useCallback(async () => {
    setError(null); setNote(null);
    const items = toPricingItems(rows);
    if (!items.length) { setError(new Error('Add at least one part number.')); return; }
    setFetching(true);
    try {
      const res = await api.fetchItemAttributes({ region, salesOrg: context.salesOrg, priceDate, items });
      const attrs = res.attributes || res.items || {};
      let n = 0;
      setRows((rs) => rs.map((r) => {
        const a = attrs[r.partNumber.trim()];
        if (!a) return r;
        n += 1;
        return { ...r, description: a.description || r.description, supplier: r.supplier || a.supplier || '', warehouse: r.warehouse || a.warehouse || '', stockClass: r.stockClass || '', resolvedStockClass: a.stockClass || null, family: a.family || null };
      }));
      setKnownParts((k) => ({ ...k, ...Object.fromEntries(Object.entries(attrs).filter(([, a]) => a).map(([p, a]) => [p, a.description || ''])) }));
      setNote(`Fetched attributes for ${n} of ${items.length} parts — review the lines, then price.`);
    } catch (e) { setError(e); } finally { setFetching(false); }
  }, [rows, region, context.salesOrg, priceDate]);

  useEffect(() => { setKnownParts((k) => ({ ...k, ...Object.fromEntries(rows.filter((r) => r.partNumber && r.description).map((r) => [r.partNumber, r.description])) })); }, [rows]);

  const lineFor = useCallback((row) => results?.byRowId?.[row.id] || null, [results]);
  const isStale = useCallback((row) => Boolean(row.pricedSignature) && row.pricedSignature !== signatureOf(row), []);

  return {
    customerId, customers, party, selectCustomer, region, selectRegion, route, priceDate, setPriceDate, regions: REGIONS,
    rows, setRows, updateRow, removeRow, addRow, addRows, toggleKit, updateComponent, addComponent, removeComponent,
    results, lineFor, isStale, pricing, fetching, error, setError, note, priceAll, repriceLine, fetchAttributes,
    suppliers, regionConfig, knownParts, context, quoteId: QUOTE_ID,
    items: toPricingItems(rows), clearResults: () => setResults(null), cloneRows: () => clone(rows),
  };
}
