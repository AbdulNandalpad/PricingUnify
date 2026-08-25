import { Fragment, useState } from 'react';
import {
  DEMO_USERS,
  ApiError,
  getEffectiveConfig,
  listVersions,
  getEffectiveSupplierConfig,
  listSuggestions,
  suggestChange,
  approveSuggestion,
  rejectSuggestion,
} from './api';

const REGIONS = ['EUROPE', 'CHINA', 'INDIA', 'AMERICAS'];
const ADMIN_SECTIONS = ['Region config', 'Supplier config', 'AI suggestions'];

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function errorMessage(err) {
  return err instanceof ApiError ? `${err.status}: ${err.message}` : err.message;
}

/** Renders one region-config document: buildUp, constraints, and whichever optional
 * config-driven maps/sequences it declares (costAccessSequence, stockClassMap,
 * additionalCostMap, resolution) — a config that doesn't declare one just omits that section,
 * same as how the engine itself treats an absent map as "not a concern for this region". */
function RegionConfigDetail({ config }) {
  return (
    <div className="admin-config-detail">
      <dl className="config-meta">
        <div><dt>Version</dt><dd className="mono">{config.version}</dd></div>
        <div><dt>Status</dt><dd><span className={`badge-status badge-status-${config.status === 'ACTIVE' ? 'priced' : 'missing'}`}>{config.status}</span></dd></div>
        <div><dt>Valid from</dt><dd className="mono">{config.validFrom}</dd></div>
        <div><dt>Valid to</dt><dd className="mono">{config.validTo || '—'}</dd></div>
        {config.rounding && <div><dt>Rounding</dt><dd className="mono">{config.rounding.mode}, {config.rounding.decimalPlaces}dp</dd></div>}
      </dl>

      <h4>Build-up</h4>
      <table className="trace-table">
        <thead>
          <tr>
            <th>ID</th><th>Type</th><th>Basis</th><th>Rate / Amount</th><th>When</th><th>Tags</th>
          </tr>
        </thead>
        <tbody>
          {config.buildUp.map((el) => (
            <tr key={el.id}>
              <td className="mono">{el.id}</td>
              <td><span className={`badge badge-${el.type.toLowerCase()}`}>{el.type}</span></td>
              <td className="mono">{el.basis ? el.basis.join(' + ') : '—'}</td>
              <td className="mono">{el.rate ?? el.rateRef ?? el.amount ?? el.amountRef ?? '—'}</td>
              <td className="mono">{el.when ? (Array.isArray(el.when) ? el.when.join(' AND ') : el.when) : '—'}</td>
              <td className="mono">{el.composite ? 'composite' : ''}{el.composite && el.allocatable === false ? ', ' : ''}{el.allocatable === false ? 'not allocatable' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {config.constraints?.length > 0 && (
        <>
          <h4>Constraints</h4>
          <table className="trace-table">
            <thead>
              <tr><th>ID</th><th>Kind</th><th>Mode</th><th>Min / Step</th></tr>
            </thead>
            <tbody>
              {config.constraints.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.id}</td>
                  <td><span className="badge badge-constraint">{c.kind}</span></td>
                  <td className="mono">{c.mode || 'PRICE'}</td>
                  <td className="mono">{c.min ?? c.minRef ?? c.step ?? c.stepRef ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {config.costAccessSequence && (
        <>
          <h4>Cost access sequence</h4>
          <p className="mono">{config.costAccessSequence.join(' → ')}</p>
        </>
      )}

      {config.stockClassMap && (
        <>
          <h4>Stock class map</h4>
          <table className="trace-table">
            <thead><tr><th>Raw code</th><th>Canonical</th></tr></thead>
            <tbody>
              {Object.entries(config.stockClassMap).map(([raw, canonical]) => (
                <tr key={raw}><td className="mono">{raw}</td><td className="mono">{canonical}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {config.additionalCostMap && (
        <>
          <h4>Additional cost map</h4>
          <table className="trace-table">
            <thead><tr><th>Flag</th><th>Markup</th><th>Landed cost</th><th>Tariff</th><th>Pick</th></tr></thead>
            <tbody>
              {Object.entries(config.additionalCostMap).map(([flag, m]) => (
                <tr key={flag}>
                  <td className="mono">{flag}</td>
                  <td className="mono">{String(m.markup)}</td>
                  <td className="mono">{String(m.landedCost)}</td>
                  <td className="mono">{String(m.tariff)}</td>
                  <td className="mono">{String(m.pick)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {config.resolution?.length > 0 && (
        <>
          <h4>Resolution ladder</h4>
          <table className="trace-table">
            <thead><tr><th>ID</th><th>Stock class</th><th>Origin of data</th><th>Cost basis</th><th>Fallback</th></tr></thead>
            <tbody>
              {config.resolution.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td className="mono">{r.stockClass || '—'}</td>
                  <td className="mono">{r.originOfData || '—'}</td>
                  <td className="mono">{r.costBasis || '—'}</td>
                  <td className="mono">{r.fallback ? r.fallback.join(' → ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function RegionConfigSection({ user, region, salesOrg, asOf }) {
  const [current, setCurrent] = useState(null);
  const [versions, setVersions] = useState(null);
  const [expandedVersion, setExpandedVersion] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    setCurrent(null);
    setVersions(null);
    setExpandedVersion(null);
    try {
      const [config, versionList] = await Promise.all([
        getEffectiveConfig({ user, region, salesOrg, asOf }),
        listVersions({ user, region, salesOrg }),
      ]);
      setCurrent(config);
      setVersions(versionList.versions);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button type="button" onClick={load} disabled={loading}>
        {loading ? 'Loading…' : `Load ${region}/${salesOrg} config`}
      </button>
      {error && <p className="error">{error}</p>}

      {current && (
        <>
          <h3>Effective as of {asOf || 'today'}</h3>
          <RegionConfigDetail config={current} />
        </>
      )}

      {versions && (
        <>
          <h3>Version history ({versions.length})</h3>
          <table className="results-table">
            <thead>
              <tr><th>Version</th><th>Status</th><th>Valid from</th><th>Valid to</th><th aria-hidden="true"></th></tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <Fragment key={v.version}>
                  <tr
                    className="results-row"
                    onClick={() => setExpandedVersion((cur) => (cur === v.version ? null : v.version))}
                  >
                    <td className="mono">{v.version}</td>
                    <td><span className={`badge-status badge-status-${v.status === 'ACTIVE' ? 'priced' : 'missing'}`}>{v.status}</span></td>
                    <td className="mono">{v.validFrom}</td>
                    <td className="mono">{v.validTo || '—'}</td>
                    <td className="expand-chevron">{expandedVersion === v.version ? '▾' : '▸'}</td>
                  </tr>
                  {expandedVersion === v.version && (
                    <tr className="results-detail-row">
                      <td colSpan={5}><RegionConfigDetail config={v} /></td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function SupplierConfigSection({ user, region, salesOrg, asOf }) {
  const [supplier, setSupplier] = useState('ACME');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setNotFound(false);
    try {
      const config = await getEffectiveSupplierConfig({ user, region, salesOrg, supplier, asOf });
      setResult(config);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="field-grid">
        <Field label="Supplier">
          <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. ACME" />
        </Field>
      </div>
      <button type="button" onClick={load} disabled={loading || !supplier.trim()}>
        {loading ? 'Loading…' : `Look up ${region}/${salesOrg}/${supplier || '…'}`}
      </button>
      {error && <p className="error">{error}</p>}
      {notFound && <p className="missing-reason">No effective supplier-config for "{supplier}" in {region}/{salesOrg}.</p>}
      {result && (
        <dl className="config-meta">
          <div><dt>Version</dt><dd className="mono">{result.version}</dd></div>
          <div><dt>Valid from</dt><dd className="mono">{result.validFrom}</dd></div>
          <div><dt>Freight</dt><dd className="mono">{result.freight ?? '—'}</dd></div>
          <div><dt>Duty</dt><dd className="mono">{result.duty ?? '—'}</dd></div>
          <div><dt>Tariff</dt><dd className="mono">{result.tariff ?? '—'}</dd></div>
          <div><dt>MOLV</dt><dd className="mono">{result.molv ?? '—'}</dd></div>
          <div><dt>MOQ</dt><dd className="mono">{result.moq ?? '—'}</dd></div>
        </dl>
      )}
    </div>
  );
}

function AiSuggestionsSection({ user, region, salesOrg }) {
  const isAdmin = user === 'bob';
  const [status, setStatus] = useState('');
  const [suggestions, setSuggestions] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [requestNote, setRequestNote] = useState(null);
  const [actionNotes, setActionNotes] = useState({});

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listSuggestions({ user, region, status: status || undefined });
      setSuggestions(res.suggestions);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleRequest = async (e) => {
    e.preventDefault();
    setRequestNote(null);
    try {
      const res = await suggestChange({ user, region, salesOrg, instruction });
      if (res.status === 'AI_NOT_CONFIGURED') {
        setRequestNote(res.message);
      } else {
        setRequestNote('Suggestion created — reload the list below to see it.');
        setInstruction('');
      }
    } catch (err) {
      setRequestNote(errorMessage(err));
    }
  };

  const handleApprove = async (suggestionId) => {
    const newVersion = actionNotes[suggestionId]?.newVersion;
    if (!newVersion) return;
    try {
      await approveSuggestion({ user, suggestionId, newVersion });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const handleReject = async (suggestionId) => {
    try {
      await rejectSuggestion({ user, suggestionId, reviewNotes: actionNotes[suggestionId]?.reviewNotes });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div>
      {isAdmin && (
        <>
          <h3>Request a new AI suggestion</h3>
          <form onSubmit={handleRequest} className="field-grid">
            <Field label="Instruction">
              <input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. increase SCM markup to 5%" />
            </Field>
            <button type="submit" disabled={!instruction.trim()}>Suggest</button>
          </form>
          {requestNote && <p className="hint">{requestNote}</p>}
        </>
      )}

      <h3>Review queue</h3>
      <div className="field-grid">
        <Field label="Status filter">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="PENDING_REVIEW">Pending review</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </Field>
      </div>
      <button type="button" onClick={load} disabled={loading}>{loading ? 'Loading…' : `Load suggestions for ${region}`}</button>
      {error && <p className="error">{error}</p>}

      {suggestions && suggestions.length === 0 && <p className="hint">No suggestions match this filter.</p>}

      {suggestions && suggestions.length > 0 && (
        <table className="results-table">
          <thead>
            <tr><th>ID</th><th>Instruction</th><th>Status</th><th>Confidence</th><th aria-hidden="true"></th></tr>
          </thead>
          <tbody>
            {suggestions.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.id}</td>
                <td>{s.instruction}</td>
                <td><span className="badge-status badge-status-missing">{s.status}</span></td>
                <td className="mono">{s.confidence ?? '—'}</td>
                <td>
                  {isAdmin && s.status === 'PENDING_REVIEW' && (
                    <div className="suggestion-actions">
                      <input
                        className="mono"
                        placeholder="new version id"
                        onChange={(e) => setActionNotes((cur) => ({ ...cur, [s.id]: { ...cur[s.id], newVersion: e.target.value } }))}
                      />
                      <button type="button" onClick={() => handleApprove(s.id)}>Approve</button>
                      <button type="button" onClick={() => handleReject(s.id)}>Reject</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function AdminConfig() {
  const [user, setUser] = useState('bob');
  const [region, setRegion] = useState('EUROPE');
  const [salesOrg, setSalesOrg] = useState('*');
  const [asOf, setAsOf] = useState('');
  const [section, setSection] = useState(ADMIN_SECTIONS[0]);

  return (
    <main className="admin-layout">
      <section className="panel">
        <h2>Admin config</h2>
        <p className="hint">
          Browse a region's live config (build-up, constraints, stock class / additional-cost maps), look up
          supplier-specific overrides, and review AI-proposed config changes. Read endpoints are open to any
          authenticated user; requesting or approving an AI suggestion needs PricingAdmin (bob).
        </p>

        <div className="field-grid">
          <Field label="Signed in as">
            <select value={user} onChange={(e) => setUser(e.target.value)}>
              {Object.entries(DEMO_USERS).map(([id, u]) => (
                <option key={id} value={id}>{u.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Region">
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Sales org">
            <input value={salesOrg} onChange={(e) => setSalesOrg(e.target.value)} />
          </Field>
          <Field label="As of (blank = today)">
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
        </div>

        <nav className="mode-toggle">
          {ADMIN_SECTIONS.map((s) => (
            <button key={s} type="button" className={section === s ? 'mode-tab mode-tab-active' : 'mode-tab'} onClick={() => setSection(s)}>
              {s}
            </button>
          ))}
        </nav>

        {section === 'Region config' && <RegionConfigSection user={user} region={region} salesOrg={salesOrg} asOf={asOf} />}
        {section === 'Supplier config' && <SupplierConfigSection user={user} region={region} salesOrg={salesOrg} asOf={asOf} />}
        {section === 'AI suggestions' && <AiSuggestionsSection user={user} region={region} salesOrg={salesOrg} />}
      </section>
    </main>
  );
}
