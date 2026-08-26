import { Fragment, useEffect, useState } from 'react';
import { PURPOSE } from '@tss-pricing/engine-core';
import { priceViaBackend, listSuppliers, DEMO_USERS, ApiError } from './api';
import { DEFAULT_ROWS, newRow, newComponent, parseBulkText, toPricingItems } from './batch';
import AdminConfig from './AdminConfig.jsx';
import './App.css';

const STATUS_LABEL = {
  PRICED: 'Priced',
  MISSING: 'Missing',
  BLOCKED: 'Blocked',
};

/** The business's confirmed list of 5 pricing techniques (see CLAUDE.md Parked).
 *  Only cost-plus/landed-cost is implemented today — the rest are shown so the
 *  roadmap is visible, but can't be selected until they're actually built. */
const PRICING_TYPES = [
  { id: 'COST_PLUS', label: 'Cost-plus / Landed cost', available: true },
  { id: 'PRICE_LIST', label: 'Price list', available: false },
  { id: 'VARIANT', label: 'Variant pricing', available: false },
  { id: 'VALUE_BASED', label: 'Value-based', available: false },
  { id: 'AI_PROPOSED', label: 'AI-proposed costs', available: false },
];

// Purpose (INDICATIVE|BINDING|REPRICE|SIMULATION) stays an engine/API concept — the host
// system sets it per call in a real integration (order → BINDING refuses estimated costs).
// Removed from the UI at the owner's request; every UI call prices as INDICATIVE.

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function stepLabel(id) {
  return id.replaceAll('_', ' ');
}

/** Mockup-style numbered calculation trace: one line per step, running total on the right,
 *  the final result highlighted. Skipped (when-condition) steps stay visible but muted —
 *  a binding audit needs to see why a branch didn't apply, not just what did. */
function FormulaTrace({ steps, currency, constraintPasses, unitPrice }) {
  if (!steps?.length) return null;
  const cur = currency ? ` ${currency}` : '';
  return (
    <div className="formula-trace">
      <div className="formula-trace-header">Calculation</div>
      <div className="formula-steps">
        {steps.map((s, i) => {
          const skipped = s.note?.skipped;
          const missing = s.missing;
          let how = '';
          if (missing) how = ` — missing: ${missing.reason}`;
          else if (skipped) how = ' — not applied (condition not met)';
          else if (s.note?.basis) how = ` (${s.note.basis.map(stepLabel).join(' + ')} × ${s.note.rate})`;
          else if (s.note?.perQuantity) how = ` (per order ÷ ${s.note.perQuantity})`;
          else if (s.note?.source) how = ` (from ${s.note.source})`;
          return (
            <div key={s.id} className={`formula-step${skipped || missing ? ' formula-step-skipped' : ''}`}>
              <div className="formula-step-num">{i + 1}</div>
              <div className="formula-step-text">
                {s.type === 'BASE' ? '' : '+ '}{stepLabel(s.id)}{how}
              </div>
              <div className="formula-step-value">
                {skipped || missing ? '—' : `${s.runningTotal}${cur}`}
              </div>
            </div>
          );
        })}
        {unitPrice !== undefined && (
          <div className="formula-step formula-step-final">
            <div className="formula-step-num">=</div>
            <div className="formula-step-text">
              Unit price{constraintPasses?.length > 0 ? ' (after order rules)' : ''}
            </div>
            <div className="formula-step-value">{unitPrice}{cur}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** selectedBy is 'USER' | 'DEFAULT' | 'ACCESS_SEQUENCE:<system>' — see engine-core/src/kernel.js. */
function describeSelection(selectedBy) {
  if (selectedBy === 'USER') return 'manually selected';
  if (selectedBy?.startsWith('ACCESS_SEQUENCE:')) {
    return `picked by cost source order → ${selectedBy.split(':')[1]}`;
  }
  return 'default source';
}

/** Mockup-style per-element breakdown cards, derived straight from the trace steps —
 *  a skipped (when-condition) element shows as N/A rather than disappearing. */
function BreakdownCards({ steps, currency }) {
  if (!steps?.length) return null;
  return (
    <div className="breakdown-grid">
      {steps.map((s) => {
        const skipped = s.note?.skipped || s.missing;
        const dotClass = skipped ? 'dot-skipped' : `dot-${s.type.toLowerCase()}`;
        return (
          <div className="breakdown-card" key={s.id}>
            <div className="breakdown-card-label"><span className={`dot ${dotClass}`}></span>{s.id.replaceAll('_', ' ')}</div>
            <div className={`breakdown-card-value ${skipped ? 'zero' : ''}`}>
              {skipped ? 'N/A' : `${s.delta ?? '—'}${currency ? ` ${currency}` : ''}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Sell-price what-if on top of the landed cost, straight from the owner's mockup:
 *  sell = landed / (1 − margin%). UI-only — engine margin logic itself is still parked. */
function MarginWhatIf({ unitPrice, currency }) {
  const [margin, setMargin] = useState(30);
  const lc = Number(unitPrice);
  const m = Number(margin) || 0;
  const sell = m >= 100 || Number.isNaN(lc) ? null : lc / (1 - m / 100);
  return (
    <div className="margin-section">
      <h3>Sell price &amp; margin</h3>
      <div className="margin-row">
        <input type="number" step="0.1" min="0" max="99.9" value={margin} onChange={(e) => setMargin(e.target.value)} />
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>%</span>
        <div className="margin-bar-wrap"><div className="margin-bar" style={{ width: `${Math.min(Math.max(m, 0), 100)}%` }} /></div>
        <span className="margin-result">{sell === null ? '∞' : `${sell.toFixed(2)} ${currency}`}</span>
      </div>
      <p className="margin-note">
        Sell price = landed cost ÷ (1 − margin%). What-if only — margin never changes the calculated landed cost
        {sell !== null && !Number.isNaN(lc) ? `; margin/unit ${(sell - lc).toFixed(2)} ${currency}` : ''}.
      </p>
    </div>
  );
}

/** A kit header line: unit price = Σ(component price × component qty). Each component is a
 *  full priced line of its own — expandable to its complete calculation. */
function KitComponents({ components }) {
  if (!components?.length) return null;
  return (
    <div className="kit-components">
      <h3>Kit components</h3>
      {components.map((comp, i) => (
        <details key={`${comp.partNumber}-${i}`} className="kit-component-detail">
          <summary>
            <span className="mono">{comp.partNumber}</span>
            {' — '}
            {comp.status === 'PRICED'
              ? `${comp.result.quantity} × ${comp.result.unitPrice} ${comp.result.currency}`
              : (comp.missing?.reason || comp.status)}
          </summary>
          <LineDetail line={comp} />
        </details>
      ))}
    </div>
  );
}

/** Mockup-style detail header: part number + region/stock class/qty tags on the left, the
 *  big unit price on the right. */
function DetailHeader({ line, regionLabel }) {
  return (
    <div className="detail-header">
      <div>
        <div className="detail-part">{line.partNumber}</div>
        <div className="detail-tags">
          {regionLabel && <span className="detail-tag detail-tag-region">{regionLabel}</span>}
          {line.trace?.stockClass && <span className="detail-tag detail-tag-stock">{line.trace.stockClass}</span>}
          {line.trace?.kit && <span className="detail-tag detail-tag-stock">KIT</span>}
          {line.result?.quantity !== undefined && <span className="detail-tag">Qty {line.result.quantity}</span>}
        </div>
      </div>
      {line.status === 'PRICED' && (
        <div className="detail-price">
          <div className="detail-price-label">Unit price</div>
          <div className="detail-price-value">{line.result.unitPrice}</div>
          <div className="detail-price-unit">{line.result.currency} / unit</div>
        </div>
      )}
    </div>
  );
}

function LineDetail({ line }) {
  return (
    <>
      {line.missing && (
        <p className="missing-reason">
          {line.missing.reason}
          {line.missing.elementId ? ` (element: ${line.missing.elementId})` : ''}
          {line.missing.componentPartNumber ? ` (component: ${line.missing.componentPartNumber})` : ''}
        </p>
      )}
      {line.trace.costCandidate && (
        <p className="candidate-line">
          Cost used: <strong>{line.trace.costCandidate.value} {line.trace.costCandidate.currency}</strong>{' '}
          ({line.trace.costCandidate.confidence}, {line.trace.costCandidate.basis}
          {line.trace.costCandidate.source?.system ? `, from ${line.trace.costCandidate.source.system}` : ''}) —{' '}
          {describeSelection(line.trace.costCandidate.selectedBy)}
        </p>
      )}
      <BreakdownCards steps={line.trace.steps} currency={line.result?.currency} />
      <FormulaTrace
        steps={line.trace.steps}
        currency={line.result?.currency}
        constraintPasses={line.trace.constraintPasses}
        unitPrice={line.result?.unitPrice}
      />
      {line.trace.kit && <KitComponents components={line.trace.components} />}
      {line.status === 'PRICED' && line.result && (
        <MarginWhatIf unitPrice={line.result.unitPrice} currency={line.result.currency} />
      )}
      {line.trace.constraintPasses?.length > 0 && (
        <div className="constraints">
          <h3>Order rules applied (minimums, floors)</h3>
          <ul>
            {line.trace.constraintPasses.map((c, i) => (
              <li key={i} className="mono">
                {c.id} ({c.kind}{c.mode ? `, ${c.mode.toLowerCase()}-adjust` : ''}):{' '}
                {c.mode === 'QUANTITY' ? `quantity ${c.quantityFrom} → ${c.quantityTo}` : `${c.from} → ${c.to}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** The "real app" experience: a parts grid (add rows, paste/upload many), one batch call
 *  to the backend, and a results table you drill into per line. Facts are resolved by the
 *  backend's API6 client (recorded payload today) — not entered by hand. */
function BatchWorkspace({ region, setRegion, goToConfig }) {
  const [globals, setGlobals] = useState({ user: 'alice', salesOrg: '*', purpose: PURPOSE.INDICATIVE, pricingType: 'COST_PLUS' });
  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [bulkText, setBulkText] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [knownSuppliers, setKnownSuppliers] = useState([]);

  useEffect(() => {
    let cancelled = false;
    // Suppliers are global (independent of region) — fetched once, not per-region.
    listSuppliers({ user: 'alice' })
      .then((res) => { if (!cancelled) setKnownSuppliers(res.suppliers || []); })
      .catch(() => { if (!cancelled) setKnownSuppliers([]); });
    return () => { cancelled = true; };
  }, []);

  function updateGlobal(key, value) {
    setGlobals((g) => ({ ...g, [key]: value }));
  }
  function updateRow(index, key, value) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
  }
  /** Picking a supplier from the dropdown also fills in its known country — the same
   *  autofill srv's applySupplierOverrides does server-side, just visible here so the field
   *  isn't left blank until pricing runs. Still just a starting value: typing over it wins,
   *  same "explicit selection always wins" precedence as everywhere else. */
  function pickSupplier(index, supplierId) {
    const s = knownSuppliers.find((x) => x.supplier === supplierId);
    setRows((rs) => rs.map((r, i) => (i === index ? {
      ...r,
      supplier: supplierId,
      ...(s?.supplierCountry ? { supplierCountry: s.supplierCountry } : {}),
    } : r)));
  }
  function removeRow(index) {
    setRows((rs) => rs.filter((_, i) => i !== index));
  }
  function addRow() {
    setRows((rs) => [...rs, newRow()]);
  }
  function toggleKit(index) {
    setRows((rs) => rs.map((r, i) => {
      if (i !== index) return r;
      // Opening the editor on a row with no components yet seeds one blank component line.
      const components = !r.kitOpen && r.components.length === 0 ? [newComponent()] : r.components;
      return { ...r, kitOpen: !r.kitOpen, components };
    }));
  }
  function updateComponent(rowIndex, compIndex, key, value) {
    setRows((rs) => rs.map((r, i) => (i === rowIndex
      ? { ...r, components: r.components.map((c, ci) => (ci === compIndex ? { ...c, [key]: value } : c)) }
      : r)));
  }
  function addComponent(rowIndex) {
    setRows((rs) => rs.map((r, i) => (i === rowIndex ? { ...r, components: [...r.components, newComponent()] } : r)));
  }
  function removeComponent(rowIndex, compIndex) {
    setRows((rs) => rs.map((r, i) => (i === rowIndex
      ? { ...r, components: r.components.filter((_, ci) => ci !== compIndex) }
      : r)));
  }
  function addBulkRows() {
    const parsed = parseBulkText(bulkText);
    if (parsed.length === 0) return;
    setRows((rs) => [...rs, ...parsed]);
    setBulkText('');
    setShowBulk(false);
  }
  function handleFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseBulkText(String(reader.result));
      if (parsed.length > 0) setRows((rs) => [...rs, ...parsed]);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function runBatch(e) {
    e.preventDefault();
    setError(null);
    const items = toPricingItems(rows);
    if (items.length === 0) {
      setError('Add at least one part number.');
      return;
    }
    setLoading(true);
    setExpandedIndex(null);
    try {
      const body = await priceViaBackend({ ...globals, region, items });
      setResult({ ...body, submittedItems: items });
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : err.message);
    } finally {
      setLoading(false);
    }
  }

  const lines = result?.items;
  const counts = lines?.reduce((acc, l) => ({ ...acc, [l.status]: (acc[l.status] || 0) + 1 }), {});

  // Display-only order math: line total = unit price × (possibly rule-adjusted) quantity,
  // summed per currency across PRICED lines. The engine prices per line; these totals are a
  // UI convenience, so plain Number arithmetic (not decimal.js) is acceptable here.
  const lineTotal = (line) =>
    line.status === 'PRICED' ? Number(line.result.unitPrice) * Number(line.result.quantity) : null;
  const orderTotals = lines
    ? Object.entries(
        lines.reduce((acc, l) => {
          const t = lineTotal(l);
          if (t === null || Number.isNaN(t)) return acc;
          acc[l.result.currency] = (acc[l.result.currency] || 0) + t;
          return acc;
        }, {}),
      )
    : [];

  return (
    <main className="layout layout-wide">
      <form className="panel" onSubmit={runBatch}>
        <h2>Parts to price</h2>
        <p className="hint">
          Enter part numbers and quantities — costs, freight, duty and other charges are looked up
          automatically. Open any priced line in the results to see exactly how its price was built.
        </p>
        <details className="hint">
          <summary>Sample parts to try (demo data)</summary>
          <p>
            <strong>Verification parts</strong> — one per region, each with a static base cost of exactly{' '}
            <code>100.00</code> and round charges, so every configured factor is directly readable in the
            result: <code>EU-T100</code> (qty 10 → 129.7 EUR: 4.7% markup + 10 freight + 5 duty + 8 tariff +
            2 pick), <code>CN-T100</code> (data origin CN → 103.2 CNY; data origin SAP + supplier country US → 136.22),{' '}
            <code>IN-T100</code> (supplier country IN → 100; otherwise → 140), <code>US-T100</code> (qty 10,
            supplier country US → 133.1 USD; otherwise → 136.9).
          </p>
          <p>
            Other parts: <code>P-10023</code>, <code>P-20045</code>, <code>P-30078</code> price normally.{' '}
            <code>P-40012</code> has only an estimated cost — pick the Binding purpose to see it held back.{' '}
            <code>P-60150</code> has a manually entered cost that wins over the ERP one.{' '}
            <code>P-70200</code> with supplier <code>ACME</code> shows supplier-specific charges and order
            minimums. CHINA: <code>CN-P001</code>…<code>CN-P006</code>; INDIA <code>IN-P001</code>/
            <code>IN-P002</code>; AMERICAS <code>US-P001</code>…<code>US-P004</code>. Unknown part numbers
            come back as Missing.
          </p>
        </details>

        <div className="field-grid">
          <Field label="Signed in as">
            <select value={globals.user} onChange={(e) => updateGlobal('user', e.target.value)}>
              {Object.entries(DEMO_USERS).map(([id, u]) => (
                <option key={id} value={id}>{u.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Region">
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              {['EUROPE', 'CHINA', 'INDIA', 'AMERICAS'].map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </Field>
          <Field label="Sales org">
            <input value={globals.salesOrg} onChange={(e) => updateGlobal('salesOrg', e.target.value)} />
          </Field>
          <Field label="Pricing type">
            <select value={globals.pricingType} onChange={(e) => updateGlobal('pricingType', e.target.value)}>
              {PRICING_TYPES.map((t) => (
                <option key={t.id} value={t.id} disabled={!t.available}>
                  {t.label}{t.available ? '' : ' — coming soon'}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="item-grid-scroll">
          <table className={showAdvanced ? 'item-grid item-grid-advanced' : 'item-grid'}>
            <thead>
              <tr>
                <th>Part number</th>
                <th>Qty</th>
                <th title="Supplier for this line — supplier-specific charges and order minimums apply when set">Supplier</th>
                <th title="The supplier's own country — drives freight/duty and the local vs. overseas handling rate in China, Americas and India">Supplier country</th>
                {showAdvanced && (
                  <>
                    <th title="Origin of Data — which system the part's cost data comes from (e.g. SMA, SAP, CN, IN)">Data origin (OOD)</th>
                    <th title="Destination warehouse — which of the supplier's per-warehouse freight/duty/tariff terms apply (e.g. EU01, US01, CN01, IN01)">Warehouse</th>
                    <th title="What-if: price at this hypothetical order quantity instead of the entered one (Americas quantity breaks)">Qty override</th>
                  </>
                )}
                <th aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const colCount = showAdvanced ? 8 : 5;
                const componentCount = row.components.filter((c) => c.partNumber.trim()).length;
                return (
                  <Fragment key={row.id}>
                    <tr>
                      <td><input value={row.partNumber} onChange={(e) => updateRow(i, 'partNumber', e.target.value)} placeholder="P-10023" /></td>
                      <td><input className="qty-input" type="number" min="1" value={row.quantity} onChange={(e) => updateRow(i, 'quantity', e.target.value)} /></td>
                      <td>
                    {knownSuppliers.length > 0 ? (
                      <select value={row.supplier} onChange={(e) => pickSupplier(i, e.target.value)}>
                        <option value="">— none —</option>
                        {knownSuppliers.map((s) => (
                          <option key={s.supplier} value={s.supplier}>{s.supplier}{s.supplierCountry ? ` (${s.supplierCountry})` : ''}</option>
                        ))}
                        {row.supplier && !knownSuppliers.some((s) => s.supplier === row.supplier) && (
                          <option value={row.supplier}>{row.supplier}</option>
                        )}
                      </select>
                    ) : (
                      <input value={row.supplier} onChange={(e) => updateRow(i, 'supplier', e.target.value)} placeholder="e.g. ACME" />
                    )}
                  </td>
                      <td><input className="ood-input" value={row.supplierCountry} onChange={(e) => updateRow(i, 'supplierCountry', e.target.value)} placeholder="e.g. US" /></td>
                      {showAdvanced && (
                        <>
                          <td><input className="ood-input" value={row.ood} onChange={(e) => updateRow(i, 'ood', e.target.value)} placeholder="e.g. SMA" /></td>
                          <td><input className="ood-input" value={row.warehouse} onChange={(e) => updateRow(i, 'warehouse', e.target.value)} placeholder="e.g. EU01" /></td>
                          <td><input className="qty-input" type="number" min="0" value={row.mroqOverride} onChange={(e) => updateRow(i, 'mroqOverride', e.target.value)} placeholder="qty" /></td>
                        </>
                      )}
                      <td className="row-actions">
                        <button
                          type="button"
                          className="kit-toggle"
                          onClick={() => toggleKit(i)}
                          title="A kit line is priced as the sum of its components (Americas and China only)"
                        >
                          {componentCount > 0 ? `kit (${componentCount})` : '+ kit'}
                        </button>
                        <button type="button" className="row-remove" onClick={() => removeRow(i)} aria-label={`Remove ${row.partNumber || 'row'}`}>×</button>
                      </td>
                    </tr>
                    {row.kitOpen && (
                      <tr className="kit-editor-row">
                        <td colSpan={colCount}>
                          <div className="kit-editor">
                            <p className="hint">
                              Components of <strong>{row.partNumber || 'this kit'}</strong> — the kit's unit price is the
                              sum of its component prices. Kits are supported for AMERICAS and CHINA.
                            </p>
                            {row.components.map((c, ci) => (
                              <div className="kit-component-row" key={c.id}>
                                <input value={c.partNumber} onChange={(e) => updateComponent(i, ci, 'partNumber', e.target.value)} placeholder="Component part number" />
                                <input className="qty-input" type="number" min="1" value={c.quantity} onChange={(e) => updateComponent(i, ci, 'quantity', e.target.value)} title="Quantity of this component per kit" />
                                <input className="ood-input" value={c.ood} onChange={(e) => updateComponent(i, ci, 'ood', e.target.value)} placeholder="Data origin" title="Data origin (OOD) of the component's cost data" />
                                <button type="button" className="row-remove" onClick={() => removeComponent(i, ci)} aria-label="Remove component">×</button>
                              </div>
                            ))}
                            <button type="button" className="link-button" onClick={() => addComponent(i)}>+ Add component</button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid-actions">
          <button type="button" className="link-button" onClick={addRow}>+ Add row</button>
          <button type="button" className="link-button" onClick={() => setShowAdvanced((s) => !s)}>
            {showAdvanced ? 'Hide advanced fields' : 'Show advanced fields'}
          </button>
          <button type="button" className="link-button" onClick={() => setShowBulk((s) => !s)}>
            {showBulk ? 'Hide' : 'Paste or upload multiple parts'}
          </button>
        </div>

        {showBulk && (
          <div className="bulk-add">
            <p className="hint">One part per line: <code>part number, qty, supplier, supplier country, data origin, warehouse, qty override</code> — everything after the part number is optional.</p>
            <textarea
              rows={4}
              placeholder={'P-10023, 10\nP-20045, 25\nP-70200, 30, ACME\nP-90500, 60, , , SMA, , 60'}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
            />
            <div className="bulk-add-actions">
              <button type="button" onClick={addBulkRows} disabled={!bulkText.trim()}>Add these rows</button>
              <label className="file-upload">
                Upload .csv
                <input type="file" accept=".csv,.txt" onChange={handleFileUpload} />
              </label>
            </div>
          </div>
        )}

        <button type="submit" disabled={loading}>{loading ? 'Pricing…' : `Price all lines (${rows.filter((r) => r.partNumber.trim()).length})`}</button>
      </form>

      <section className="panel">
        <h2>Results</h2>
        {error && <p className="error">{error}</p>}
        {!result && !error && <p className="hint">Add parts and price the batch to see results here.</p>}

        {result && (
          <>
            <div className="quote-header">
              <div>
                <p className="quote-headline">
                  {counts?.PRICED || 0} of {lines.length} line{lines.length === 1 ? '' : 's'} priced
                  {result.region?.entityLabel ? ` · ${result.region.entityLabel}` : ''}
                </p>
                <p className="candidate-line">
                  {result.config.region} pricing rules v{result.config.version} · price date {result.priceDate}
                  {goToConfig && (
                    <>
                      {' · '}
                      <button type="button" className="link-button link-inline" onClick={goToConfig}>
                        view / edit configuration →
                      </button>
                    </>
                  )}
                </p>
              </div>
              {orderTotals.length > 0 && (
                <div className="order-totals">
                  {orderTotals.map(([currency, total]) => (
                    <div className="order-total" key={currency}>
                      <span className="order-total-label">Order total</span>
                      <span className="order-total-value">{total.toFixed(2)} {currency}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="summary-chips">
              {counts?.PRICED > 0 && <span className="chip chip-priced">{counts.PRICED} priced</span>}
              {counts?.MISSING > 0 && <span className="chip chip-missing">{counts.MISSING} missing</span>}
              {counts?.BLOCKED > 0 && <span className="chip chip-blocked">{counts.BLOCKED} blocked</span>}
            </div>

            <table className="results-table">
              <thead>
                <tr>
                  <th>Part</th>
                  <th className="num">Qty</th>
                  <th>Status</th>
                  <th className="num">Unit price</th>
                  <th className="num">Line total</th>
                  <th aria-hidden="true"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <Fragment key={`${line.partNumber}-${i}`}>
                    <tr
                      className={`results-row status-row-${line.status.toLowerCase()}`}
                      onClick={() => setExpandedIndex((cur) => (cur === i ? null : i))}
                    >
                      <td className="mono">{line.partNumber}</td>
                      <td className="num mono">
                        {line.status === 'PRICED' && line.result.quantity !== result.submittedItems[i]?.quantity
                          ? `${line.result.quantity} (was ${result.submittedItems[i]?.quantity})`
                          : result.submittedItems[i]?.quantity}
                      </td>
                      <td><span className={`badge-status badge-status-${line.status.toLowerCase()}`}>{STATUS_LABEL[line.status] || line.status}</span></td>
                      <td className="num mono">{line.status === 'PRICED' ? `${line.result.unitPrice} ${line.result.currency}` : '—'}</td>
                      <td className="num mono">
                        {line.status === 'PRICED' ? `${lineTotal(line).toFixed(2)} ${line.result.currency}` : '—'}
                      </td>
                      <td className="expand-chevron">{expandedIndex === i ? '▾' : '▸'}</td>
                    </tr>
                    {expandedIndex === i && (
                      <tr className="results-detail-row">
                        <td colSpan={6}>
                          <DetailHeader line={line} regionLabel={result.region?.entityLabel || result.config.region} />
                          <LineDetail line={line} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </main>
  );
}

const MODE_SUBTITLE = {
  backend: 'Region-aware landed cost pricing — Europe · China · India · Americas',
  admin: 'Region pricing sheets and supplier overrides',
};

export default function App() {
  const [mode, setMode] = useState('backend');
  // One region selection shared by the calculator and the configuration sheets — "view
  // configuration" from a priced result lands on exactly the region that priced it.
  const [region, setRegion] = useState('EUROPE');

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>TSS Pricing Engine</h1>
          <p className="subtitle">{MODE_SUBTITLE[mode]}</p>
        </div>
        <nav className="mode-toggle mode-toggle-header">
          <button type="button" className={mode === 'backend' ? 'mode-tab mode-tab-active' : 'mode-tab'} onClick={() => setMode('backend')}>
            Price calculator
          </button>
          <button type="button" className={mode === 'admin' ? 'mode-tab mode-tab-active' : 'mode-tab'} onClick={() => setMode('admin')}>
            Configuration
          </button>
        </nav>
      </header>

      {mode === 'backend' && <BatchWorkspace region={region} setRegion={setRegion} goToConfig={() => setMode('admin')} />}
      {mode === 'admin' && <AdminConfig region={region} setRegion={setRegion} />}
    </div>
  );
}
