import { useState } from 'react';
import { price, PURPOSE, CONFIDENCE } from '@tss-pricing/engine-core';
import { DEFAULT_FORM, buildPricingInput } from './sampleData';
import { priceViaBackend, DEMO_USERS, ApiError } from './api';
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

export default function App() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const [loading, setLoading] = useState(false);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function runPricing(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (form.mode === 'direct') {
        const input = buildPricingInput(form);
        const result = price(input);
        setOutcome({ mode: 'direct', input, line: result.items[0] });
      } else {
        const body = await priceViaBackend({
          user: form.user,
          region: form.region,
          salesOrg: form.salesOrg,
          purpose: form.purpose,
          items: [{ partNumber: form.partNumber, quantity: Number(form.quantity) }],
        });
        setOutcome({ mode: 'backend', body, line: body.items[0] });
      }
    } catch (err) {
      setOutcome(null);
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : err.message);
    } finally {
      setLoading(false);
    }
  }

  const line = outcome?.line;
  const isBackend = form.mode === 'backend';

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>TSS Pricing Engine</h1>
          <p className="subtitle">
            {isBackend
              ? 'Backend-orchestrated — React → CAP (srv/) → config-model + api6-client → engine-core'
              : 'Standalone dev console — calls engine-core directly in the browser, no backend'}
          </p>
        </div>
        <span className="phase-badge">{isBackend ? 'srv/ · CAP backend' : 'Phase 1 · engine-core'}</span>
      </header>

      <main className="layout">
        <form className="panel" onSubmit={runPricing}>
          <h2>Item &amp; facts</h2>

          <div className="mode-toggle">
            <label className={form.mode === 'direct' ? 'mode-option mode-option-active' : 'mode-option'}>
              <input type="radio" name="mode" value="direct" checked={form.mode === 'direct'} onChange={() => update('mode', 'direct')} />
              Direct (engine-core in browser)
            </label>
            <label className={form.mode === 'backend' ? 'mode-option mode-option-active' : 'mode-option'}>
              <input type="radio" name="mode" value="backend" checked={form.mode === 'backend'} onChange={() => update('mode', 'backend')} />
              Backend API (CAP)
            </label>
          </div>

          {isBackend ? (
            <p className="hint">
              Cost/freight/duty/pick-charge/MOLV come from the backend's API6 client (recorded payload for
              part <code>P-10023</code>) and the config it resolves from config-model — not from this form.
              Try a different part number to see a MISSING result.
            </p>
          ) : (
            <p className="hint">Sample EUROPE-shaped build-up: BASE → SCM 4.7% FACTOR → freight/duty ADDERs → pick-charge PER_LINE → MOLV floor.</p>
          )}

          {isBackend && (
            <div className="field-grid">
              <Field label="Signed in as">
                <select value={form.user} onChange={(e) => update('user', e.target.value)}>
                  {Object.entries(DEMO_USERS).map(([id, u]) => (
                    <option key={id} value={id}>{u.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Region">
                <input value={form.region} onChange={(e) => update('region', e.target.value)} />
              </Field>
              <Field label="Sales org">
                <input value={form.salesOrg} onChange={(e) => update('salesOrg', e.target.value)} />
              </Field>
            </div>
          )}

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
            {!isBackend && (
              <>
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
              </>
            )}
          </div>

          {!isBackend && (
            <>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={form.simulateMissingCost}
                  onChange={(e) => update('simulateMissingCost', e.target.checked)}
                />
                <span>Simulate no cost record from ERP (MISSING)</span>
              </label>

              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={form.overrideStaleCost}
                  onChange={(e) => update('overrideStaleCost', e.target.checked)}
                />
                <span>Override stale/fallback cost (needed for BINDING purpose)</span>
              </label>
            </>
          )}

          <button type="submit" disabled={loading}>{loading ? 'Pricing…' : 'Price line'}</button>
        </form>

        <section className="panel">
          <h2>Result</h2>
          {error && <p className="error">{isBackend ? 'Backend error' : 'Kernel error'}: {error}</p>}
          {!outcome && !error && <p className="hint">Fill in the form and price the line to see the trace.</p>}

          {line && (
            <>
              <div className={`status status-${line.status.toLowerCase()}`}>
                {STATUS_LABEL[line.status] || line.status}
              </div>

              {outcome.mode === 'backend' && (
                <p className="candidate-line">
                  Config <strong>{outcome.body.config.region}/{outcome.body.config.salesOrg}</strong> v{outcome.body.config.version}
                  {' '}({outcome.body.config.status}) — requested by <strong>{outcome.body.requestedBy}</strong> on {outcome.body.priceDate}
                </p>
              )}

              {line.status === 'PRICED' && (
                <div className="price-callout">
                  <span className="price-value">{line.result.unitPrice}</span>
                  <span className="price-currency">{line.result.currency}</span>
                  <span className="price-label">per unit · qty {line.result.quantity}</span>
                </div>
              )}

              {line.missing && (
                <p className="missing-reason">
                  {line.missing.reason}
                  {line.missing.elementId ? ` (element: ${line.missing.elementId})` : ''}
                </p>
              )}

              {line.trace.costCandidate && (
                <p className="candidate-line">
                  Cost candidate: <strong>{line.trace.costCandidate.value} {line.trace.costCandidate.currency}</strong>{' '}
                  ({line.trace.costCandidate.confidence}, {line.trace.costCandidate.basis}) — selected {line.trace.costCandidate.selectedBy}
                </p>
              )}

              <TraceTable steps={line.trace.steps} />

              {line.trace.constraintPasses?.length > 0 && (
                <div className="constraints">
                  <h3>Constraint passes</h3>
                  <ul>
                    {line.trace.constraintPasses.map((c, i) => (
                      <li key={i} className="mono">
                        {c.id} ({c.kind}): {c.from} → {c.to}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <button type="button" className="link-button" onClick={() => setShowRaw((s) => !s)}>
                {showRaw ? 'Hide' : 'Show'} raw {outcome.mode === 'backend' ? 'response' : 'request / facts / config / trace'}
              </button>
              {showRaw && (
                <pre className="raw-json">
                  {outcome.mode === 'backend'
                    ? JSON.stringify(outcome.body, null, 2)
                    : JSON.stringify({ request: outcome.input.request, facts: outcome.input.facts, config: outcome.input.config, line }, null, 2)}
                </pre>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
