import { Fragment, useState } from 'react';
import { price, PURPOSE, CONFIDENCE } from '@tss-pricing/engine-core';
import { DEFAULT_FORM, buildPricingInput } from './sampleData';
import { priceViaBackend, DEMO_USERS, ApiError } from './api';
import { DEFAULT_ROWS, newRow, parseBulkText, toPricingItems } from './batch';
import './App.css';

const STATUS_LABEL = {
  PRICED: 'Priced',
  MISSING: 'Missing',
  BLOCKED: 'Blocked',
};

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function TraceTable({ steps }) {
  if (!steps.length) return null;
  return (
    <table className="trace-table">
      <thead>
        <tr>
          <th>Step</th>
          <th>Type</th>
          <th>Basis / source</th>
          <th className="num">Delta</th>
          <th className="num">Running total</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s) => (
          <tr key={s.id} className={s.missing ? 'row-missing' : ''}>
            <td>{s.id}</td>
            <td>
              <span className={`badge badge-${s.type.toLowerCase()}`}>{s.type}</span>
            </td>
            <td className="mono">
              {s.missing
                ? `MISSING: ${s.missing.reason}`
                : s.note?.basis
                  ? `${s.note.basis.join(' + ')} × ${s.note.rate}`
                  : s.note?.source || (s.note?.perQuantity ? `÷ ${s.note.perQuantity}` : '—')}
            </td>
            <td className="num mono">{s.delta ?? '—'}</td>
            <td className="num mono">{s.runningTotal ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** selectedBy is 'USER' | 'DEFAULT' | 'ACCESS_SEQUENCE:<system>' — see engine-core/src/kernel.js. */
function describeSelection(selectedBy) {
  if (selectedBy === 'USER') return 'manually selected';
  if (selectedBy?.startsWith('ACCESS_SEQUENCE:')) {
    return `via cost access sequence → ${selectedBy.split(':')[1]}`;
  }
  return 'default candidate';
}

function LineDetail({ line }) {
  return (
    <>
      {line.missing && (
        <p className="missing-reason">
          {line.missing.reason}
          {line.missing.elementId ? ` (element: ${line.missing.elementId})` : ''}
        </p>
      )}
      {line.trace.costCandidate && (
        <p className="candidate-line">
          Cost candidate: <strong>{line.trace.costCandidate.value} {line.trace.costCandidate.currency}</strong>{' '}
          ({line.trace.costCandidate.confidence}, {line.trace.costCandidate.basis}
          {line.trace.costCandidate.source?.system ? `, ${line.trace.costCandidate.source.system}` : ''}) —{' '}
          {describeSelection(line.trace.costCandidate.selectedBy)}
        </p>
      )}
      <TraceTable steps={line.trace.steps} />
      {line.trace.constraintPasses?.length > 0 && (
        <div className="constraints">
          <h3>Constraint passes</h3>
          <ul>
            {line.trace.constraintPasses.map((c, i) => (
              <li key={i} className="mono">{c.id} ({c.kind}): {c.from} → {c.to}</li>
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
function BatchWorkspace() {
  const [globals, setGlobals] = useState({ user: 'alice', region: 'EUROPE', salesOrg: '*', purpose: PURPOSE.INDICATIVE });
  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [bulkText, setBulkText] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState(null);

  function updateGlobal(key, value) {
    setGlobals((g) => ({ ...g, [key]: value }));
  }
  function updateRow(index, key, value) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
  }
  function removeRow(index) {
    setRows((rs) => rs.filter((_, i) => i !== index));
  }
  function addRow() {
    setRows((rs) => [...rs, newRow()]);
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
      const body = await priceViaBackend({ ...globals, items });
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

  return (
    <main className="layout layout-wide">
      <form className="panel" onSubmit={runBatch}>
        <h2>Parts to price</h2>
        <p className="hint">
          Facts (cost, freight, duty, pick charge, MOLV) are resolved server-side by the backend's API6
          client — enter part numbers, not costs. Recorded mode knows <code>P-10023</code>, <code>P-20045</code>,{' '}
          <code>P-30078</code>, <code>P-40012</code> (FALLBACK-confidence — try BINDING purpose to see it get
          blocked), <code>P-50099</code> (only CCD/CCP candidates — try it to see the cost access sequence fall
          through), and <code>P-60150</code> (has both ERP and C4C candidates — C4C wins). Anything else comes
          back MISSING.
        </p>

        <div className="field-grid">
          <Field label="Signed in as">
            <select value={globals.user} onChange={(e) => updateGlobal('user', e.target.value)}>
              {Object.entries(DEMO_USERS).map(([id, u]) => (
                <option key={id} value={id}>{u.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Region">
            <input value={globals.region} onChange={(e) => updateGlobal('region', e.target.value)} />
          </Field>
          <Field label="Sales org">
            <input value={globals.salesOrg} onChange={(e) => updateGlobal('salesOrg', e.target.value)} />
          </Field>
          <Field label="Purpose">
            <select value={globals.purpose} onChange={(e) => updateGlobal('purpose', e.target.value)}>
              {Object.values(PURPOSE).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </Field>
        </div>

        <table className="item-grid">
          <thead>
            <tr>
              <th>Part number</th>
              <th>Quantity</th>
              <th>COO / classification</th>
              <th aria-hidden="true"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id}>
                <td><input value={row.partNumber} onChange={(e) => updateRow(i, 'partNumber', e.target.value)} placeholder="P-10023" /></td>
                <td><input className="qty-input" type="number" min="1" value={row.quantity} onChange={(e) => updateRow(i, 'quantity', e.target.value)} /></td>
                <td><input value={row.coo} onChange={(e) => updateRow(i, 'coo', e.target.value)} placeholder="e.g. CN" /></td>
                <td>
                  <button type="button" className="row-remove" onClick={() => removeRow(i)} aria-label={`Remove ${row.partNumber || 'row'}`}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="grid-actions">
          <button type="button" className="link-button" onClick={addRow}>+ Add row</button>
          <button type="button" className="link-button" onClick={() => setShowBulk((s) => !s)}>
            {showBulk ? 'Hide' : 'Paste or upload multiple parts'}
          </button>
        </div>

        {showBulk && (
          <div className="bulk-add">
            <p className="hint">One part per line: <code>partNumber, quantity, COO</code> (quantity and COO optional).</p>
            <textarea
              rows={4}
              placeholder={'P-10023, 10, DE\nP-20045, 25\nP-30078, 4, CN'}
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
            <p className="candidate-line">
              Config <strong>{result.config.region}/{result.config.salesOrg}</strong> v{result.config.version} ({result.config.status})
              {' '}— requested by <strong>{result.requestedBy}</strong> on {result.priceDate}
            </p>

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
                      <td className="num mono">{result.submittedItems[i]?.quantity}</td>
                      <td><span className={`badge-status badge-status-${line.status.toLowerCase()}`}>{STATUS_LABEL[line.status] || line.status}</span></td>
                      <td className="num mono">{line.status === 'PRICED' ? `${line.result.unitPrice} ${line.result.currency}` : '—'}</td>
                      <td className="expand-chevron">{expandedIndex === i ? '▾' : '▸'}</td>
                    </tr>
                    {expandedIndex === i && (
                      <tr className="results-detail-row">
                        <td colSpan={5}><LineDetail line={line} /></td>
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

/** Kernel-mechanics demo: one line, hand-edited facts, engine-core running in the browser
 *  — no backend. Kept simple on purpose; the real multi-part experience is BatchWorkspace. */
function DirectWorkspace() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function runPricing(e) {
    e.preventDefault();
    setError(null);
    try {
      const input = buildPricingInput(form);
      const result = price(input);
      setOutcome({ input, line: result.items[0] });
    } catch (err) {
      setOutcome(null);
      setError(err.message);
    }
  }

  const line = outcome?.line;

  return (
    <main className="layout">
      <form className="panel" onSubmit={runPricing}>
        <h2>Item &amp; facts</h2>
        <p className="hint">Sample EUROPE-shaped build-up: BASE → SCM 4.7% FACTOR → freight/duty ADDERs → pick-charge PER_LINE → MOLV floor. One line, hand-edited facts — see the kernel mechanics directly.</p>

        <div className="field-grid">
          <Field label="Part number">
            <input value={form.partNumber} onChange={(e) => update('partNumber', e.target.value)} />
          </Field>
          <Field label="Quantity">
            <input type="number" min="1" value={form.quantity} onChange={(e) => update('quantity', e.target.value)} />
          </Field>
          <Field label="Purpose">
            <select value={form.purpose} onChange={(e) => update('purpose', e.target.value)}>
              {Object.values(PURPOSE).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="Base cost">
            <input value={form.baseCostValue} onChange={(e) => update('baseCostValue', e.target.value)} />
          </Field>
          <Field label="Currency">
            <input value={form.currency} onChange={(e) => update('currency', e.target.value)} />
          </Field>
          <Field label="Cost confidence">
            <select value={form.confidence} onChange={(e) => update('confidence', e.target.value)}>
              {Object.values(CONFIDENCE).filter((c) => c !== 'MISSING').map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Freight (adder)">
            <input value={form.freight} onChange={(e) => update('freight', e.target.value)} />
          </Field>
          <Field label="Duty (adder)">
            <input value={form.duty} onChange={(e) => update('duty', e.target.value)} />
          </Field>
          <Field label="Pick charge (per line)">
            <input value={form.pickCharge} onChange={(e) => update('pickCharge', e.target.value)} />
          </Field>
          <Field label="MOLV floor">
            <input value={form.molv} onChange={(e) => update('molv', e.target.value)} />
          </Field>
        </div>

        <label className="checkbox-field">
          <input type="checkbox" checked={form.simulateMissingCost} onChange={(e) => update('simulateMissingCost', e.target.checked)} />
          <span>Simulate no cost record from ERP (MISSING)</span>
        </label>
        <label className="checkbox-field">
          <input type="checkbox" checked={form.overrideStaleCost} onChange={(e) => update('overrideStaleCost', e.target.checked)} />
          <span>Override stale/fallback cost (needed for BINDING purpose)</span>
        </label>

        <button type="submit">Price line</button>
      </form>

      <section className="panel">
        <h2>Result</h2>
        {error && <p className="error">Kernel error: {error}</p>}
        {!outcome && !error && <p className="hint">Fill in the form and price the line to see the trace.</p>}

        {line && (
          <>
            <div className={`status status-${line.status.toLowerCase()}`}>{STATUS_LABEL[line.status] || line.status}</div>
            {line.status === 'PRICED' && (
              <div className="price-callout">
                <span className="price-value">{line.result.unitPrice}</span>
                <span className="price-currency">{line.result.currency}</span>
                <span className="price-label">per unit · qty {line.result.quantity}</span>
              </div>
            )}
            <LineDetail line={line} />
            <button type="button" className="link-button" onClick={() => setShowRaw((s) => !s)}>
              {showRaw ? 'Hide' : 'Show'} raw request / facts / config / trace
            </button>
            {showRaw && (
              <pre className="raw-json">
                {JSON.stringify({ request: outcome.input.request, facts: outcome.input.facts, config: outcome.input.config, line }, null, 2)}
              </pre>
            )}
          </>
        )}
      </section>
    </main>
  );
}

export default function App() {
  const [mode, setMode] = useState('backend');
  const isBackend = mode === 'backend';

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>TSS Pricing Engine</h1>
          <p className="subtitle">
            {isBackend
              ? 'Batch pricing — React → CAP (srv/) → config-model + api6-client → engine-core'
              : 'Kernel-mechanics demo — engine-core running directly in the browser, no backend'}
          </p>
        </div>
        <nav className="mode-toggle mode-toggle-header">
          <button type="button" className={isBackend ? 'mode-tab mode-tab-active' : 'mode-tab'} onClick={() => setMode('backend')}>
            Pricing workspace
          </button>
          <button type="button" className={!isBackend ? 'mode-tab mode-tab-active' : 'mode-tab'} onClick={() => setMode('direct')}>
            Kernel demo
          </button>
        </nav>
      </header>

      {isBackend ? <BatchWorkspace /> : <DirectWorkspace />}
    </div>
  );
}
