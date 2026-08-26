import { Fragment, useEffect, useState } from 'react';
import {
  DEMO_USERS,
  ApiError,
  getEffectiveConfig,
  listVersions,
  getEffectiveSupplierConfig,
  getEffectiveRegionRoute,
  listRegionRouteVersions,
  getEffectivePartyConfig,
  listPartyConfigVersions,
  listSuggestions,
  suggestChange,
  approveSuggestion,
  rejectSuggestion,
} from './api';
import { RegionConfigEditor, SupplierConfigEditor, RegionRouteEditor, PartyConfigEditor } from './AdminConfigEdit.jsx';

const REGIONS = ['EUROPE', 'CHINA', 'INDIA', 'AMERICAS'];
const ADMIN_SECTIONS = ['Region pricing', 'Suppliers', 'Routing', 'Customers', 'AI suggestions'];

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

/** One region's config as an always-editable sheet (mockup-style): pick a region tab, the
 *  effective config loads by itself, values are edited in place, and one Save creates the
 *  new version pricing immediately uses. PricingViewer (alice) gets the same sheet read-only. */
function RegionConfigSection({ user, region, salesOrg, asOf }) {
  const isAdmin = user === 'bob';
  const [current, setCurrent] = useState(null);
  const [versions, setVersions] = useState([]);
  const [expandedVersion, setExpandedVersion] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [savedNote, setSavedNote] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setExpandedVersion(null);
    Promise.all([
      getEffectiveConfig({ user, region, salesOrg, asOf }),
      listVersions({ user, region, salesOrg }),
    ])
      .then(([config, versionList]) => {
        if (cancelled) return;
        setCurrent(config);
        setVersions(versionList.versions);
      })
      .catch((err) => {
        if (cancelled) return;
        setCurrent(null);
        setVersions([]);
        setError(errorMessage(err));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [user, region, salesOrg, asOf, reloadTick]);

  // A ready-to-use next version id so saving is one click — still editable in the save bar.
  const today = new Date().toISOString().slice(0, 10);
  const defaultVersion = `${today}-r${versions.length + 1}`;

  return (
    <div>
      {loading && <p className="hint">Loading {region} configuration…</p>}
      {error && <p className="error">{error}</p>}
      {savedNote && <p className="saved-note">{savedNote}</p>}

      {current && !loading && (
        isAdmin ? (
          <RegionConfigEditor
            key={`${region}-${salesOrg}-${current.version}`}
            user={user}
            region={region}
            salesOrg={salesOrg}
            baseConfig={current}
            defaultVersion={defaultVersion}
            onSaved={(saved) => {
              setSavedNote(`Saved ${region} configuration as version ${saved.version} — pricing uses it immediately.`);
              setReloadTick((t) => t + 1);
            }}
            onCancel={() => setReloadTick((t) => t + 1)}
          />
        ) : (
          <>
            <h3>{region} configuration <span className="hint-inline">(v{current.version} — sign in as bob/PricingAdmin to edit)</span></h3>
            <RegionConfigDetail config={current} />
          </>
        )
      )}

      {versions.length > 0 && (
        <details className="hint version-history">
          <summary>Version history ({versions.length})</summary>
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
        </details>
      )}
    </div>
  );
}

function SupplierConfigSection({ user, region, salesOrg, asOf }) {
  const isAdmin = user === 'bob';
  const [supplier, setSupplier] = useState('ACME');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [savedNote, setSavedNote] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setNotFound(false);
    setEditing(false);
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
      {savedNote && <p className="hint">{savedNote}</p>}
      {notFound && <p className="missing-reason">No effective supplier-config for "{supplier}" in {region}/{salesOrg}.</p>}

      {isAdmin && (result || notFound) && !editing && (
        <button type="button" onClick={() => { setEditing(true); setSavedNote(null); }}>
          {result ? 'Edit as new version' : 'Create supplier config'}
        </button>
      )}

      {result && !editing && (
        <dl className="config-meta">
          <div><dt>Version</dt><dd className="mono">{result.version}</dd></div>
          <div><dt>Valid from</dt><dd className="mono">{result.validFrom}</dd></div>
          <div><dt>Freight</dt><dd className="mono">{result.freight ?? '—'}</dd></div>
          <div><dt>Duty</dt><dd className="mono">{result.duty ?? '—'}</dd></div>
          <div><dt>Tariff</dt><dd className="mono">{result.tariff ?? '—'}</dd></div>
          <div><dt>MOLV</dt><dd className="mono">{result.molv ?? '—'}</dd></div>
          <div><dt>MOQ</dt><dd className="mono">{result.moq ?? '—'}</dd></div>
          <div><dt>Supplier country</dt><dd className="mono">{result.supplierCountry ?? '—'}</dd></div>
        </dl>
      )}

      {editing && (
        <SupplierConfigEditor
          user={user}
          region={region}
          salesOrg={salesOrg}
          supplier={supplier}
          base={result}
          onSaved={(saved) => { setSavedNote(`Saved version ${saved.version} — now ACTIVE.`); load(); }}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/** From the C4C payload review: a real host system sends a customer's Origin of Data +
 *  salesOrg, not our internal region code — this table resolves that combination to a
 *  region, so a pricing request can omit `region` entirely (see srv/pricing-service.js
 *  resolveRegion). Read-only browse, same shape as SupplierConfigSection. */
function RegionRouteSection({ user, salesOrg, asOf }) {
  const isAdmin = user === 'bob';
  const [ood, setOod] = useState('SAP');
  const [current, setCurrent] = useState(null);
  const [versions, setVersions] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [savedNote, setSavedNote] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setCurrent(null);
    setVersions(null);
    setNotFound(false);
    setEditing(false);
    try {
      const [route, versionList] = await Promise.all([
        getEffectiveRegionRoute({ user, ood, salesOrg, asOf }),
        listRegionRouteVersions({ user, ood, salesOrg }),
      ]);
      setCurrent(route);
      setVersions(versionList.versions);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <p className="hint">Resolves which region a customer's Origin of Data + sales org routes to — the piece a real C4C payload needs since it never sends our internal region code directly.</p>
      <div className="field-grid">
        <Field label="Origin of Data (OOD)">
          <input value={ood} onChange={(e) => setOod(e.target.value)} placeholder="e.g. SAP, SMA, CN, IN" />
        </Field>
      </div>
      <button type="button" onClick={load} disabled={loading || !ood.trim()}>
        {loading ? 'Loading…' : `Look up ${ood || '…'}/${salesOrg}`}
      </button>
      {error && <p className="error">{error}</p>}
      {savedNote && <p className="hint">{savedNote}</p>}
      {notFound && <p className="missing-reason">No effective region-route for "{ood}" / {salesOrg}.</p>}

      {isAdmin && (current || notFound) && !editing && (
        <button type="button" onClick={() => { setEditing(true); setSavedNote(null); }}>
          {current ? 'Edit as new version' : 'Create region route'}
        </button>
      )}

      {current && !editing && (
        <dl className="config-meta">
          <div><dt>Region</dt><dd className="mono">{current.region}</dd></div>
          <div><dt>Entity label</dt><dd>{current.entityLabel || '—'}</dd></div>
          <div><dt>Version</dt><dd className="mono">{current.version}</dd></div>
          <div><dt>Valid from</dt><dd className="mono">{current.validFrom}</dd></div>
        </dl>
      )}

      {editing && (
        <RegionRouteEditor
          user={user}
          ood={ood}
          salesOrg={salesOrg}
          base={current}
          onSaved={(saved) => { setSavedNote(`Saved version ${saved.version} — now ACTIVE.`); load(); }}
          onCancel={() => setEditing(false)}
        />
      )}

      {versions && versions.length > 0 && (
        <>
          <h4>Version history ({versions.length})</h4>
          <table className="results-table">
            <thead><tr><th>Version</th><th>Status</th><th>Region</th><th>Valid from</th><th>Valid to</th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version}>
                  <td className="mono">{v.version}</td>
                  <td><span className={`badge-status badge-status-${v.status === 'ACTIVE' ? 'priced' : 'missing'}`}>{v.status}</span></td>
                  <td className="mono">{v.region}</td>
                  <td className="mono">{v.validFrom}</td>
                  <td className="mono">{v.validTo || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/** Customer/party master data — territory, country, currency, and the customer's own OOD
 *  (which can diverge from an item's own ood/coo on the same order). First real consumer of
 *  the `party.customerId` field the object-agnostic request has carried since Phase 1 but
 *  nothing previously read. Read-only browse, same shape as SupplierConfigSection. */
function PartyConfigSection({ user, asOf }) {
  const isAdmin = user === 'bob';
  const [customerId, setCustomerId] = useState('CUST-DE-001');
  const [current, setCurrent] = useState(null);
  const [versions, setVersions] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [savedNote, setSavedNote] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setCurrent(null);
    setVersions(null);
    setNotFound(false);
    setEditing(false);
    try {
      const [config, versionList] = await Promise.all([
        getEffectivePartyConfig({ user, customerId, asOf }),
        listPartyConfigVersions({ user, customerId }),
      ]);
      setCurrent(config);
      setVersions(versionList.versions);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <p className="hint">Customer master data from the host system's Customer Payload (e.g. C4C) — territory, country, currency, and the customer's own OOD.</p>
      <div className="field-grid">
        <Field label="Customer ID">
          <input value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="e.g. CUST-DE-001" />
        </Field>
      </div>
      <button type="button" onClick={load} disabled={loading || !customerId.trim()}>
        {loading ? 'Loading…' : `Look up ${customerId || '…'}`}
      </button>
      {error && <p className="error">{error}</p>}
      {savedNote && <p className="hint">{savedNote}</p>}
      {notFound && <p className="missing-reason">No effective party-config for "{customerId}".</p>}

      {isAdmin && (current || notFound) && !editing && (
        <button type="button" onClick={() => { setEditing(true); setSavedNote(null); }}>
          {current ? 'Edit as new version' : 'Create party config'}
        </button>
      )}

      {current && !editing && (
        <dl className="config-meta">
          <div><dt>Territory</dt><dd>{current.territory || '—'}</dd></div>
          <div><dt>Customer country</dt><dd className="mono">{current.customerCountry || '—'}</dd></div>
          <div><dt>Customer currency</dt><dd className="mono">{current.customerCurrency || '—'}</dd></div>
          <div><dt>Customer OOD</dt><dd className="mono">{current.customerOod || '—'}</dd></div>
          <div><dt>Version</dt><dd className="mono">{current.version}</dd></div>
          <div><dt>Valid from</dt><dd className="mono">{current.validFrom}</dd></div>
        </dl>
      )}

      {editing && (
        <PartyConfigEditor
          user={user}
          customerId={customerId}
          base={current}
          onSaved={(saved) => { setSavedNote(`Saved version ${saved.version} — now ACTIVE.`); load(); }}
          onCancel={() => setEditing(false)}
        />
      )}

      {versions && versions.length > 0 && (
        <>
          <h4>Version history ({versions.length})</h4>
          <table className="results-table">
            <thead><tr><th>Version</th><th>Status</th><th>Customer OOD</th><th>Valid from</th><th>Valid to</th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version}>
                  <td className="mono">{v.version}</td>
                  <td><span className={`badge-status badge-status-${v.status === 'ACTIVE' ? 'priced' : 'missing'}`}>{v.status}</span></td>
                  <td className="mono">{v.customerOod || '—'}</td>
                  <td className="mono">{v.validFrom}</td>
                  <td className="mono">{v.validTo || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
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

export default function AdminConfig({ region: regionProp, setRegion: setRegionProp }) {
  const [user, setUser] = useState('bob');
  const [regionLocal, setRegionLocal] = useState('EUROPE');
  const region = regionProp ?? regionLocal;
  const setRegion = setRegionProp ?? setRegionLocal;
  const [salesOrg, setSalesOrg] = useState('*');
  const [asOf, setAsOf] = useState('');
  const [section, setSection] = useState(ADMIN_SECTIONS[0]);

  const regionMatters = section === 'Region pricing' || section === 'Suppliers' || section === 'AI suggestions';

  return (
    <main className="admin-layout">
      <section className="panel">
        <div className="config-header">
          <div>
            <h2>Configuration</h2>
            <p className="hint">
              Every number behind a price lives here — pick a region and edit its pricing sheet directly.
              Viewing is open to everyone; saving needs PricingAdmin (bob).
            </p>
          </div>
          <Field label="Signed in as">
            <select value={user} onChange={(e) => setUser(e.target.value)}>
              {Object.entries(DEMO_USERS).map(([id, u]) => (
                <option key={id} value={id}>{u.label}</option>
              ))}
            </select>
          </Field>
        </div>

        <nav className="mode-toggle">
          {ADMIN_SECTIONS.map((s) => (
            <button key={s} type="button" className={section === s ? 'mode-tab mode-tab-active' : 'mode-tab'} onClick={() => setSection(s)}>
              {s}
            </button>
          ))}
        </nav>

        {regionMatters && (
          <div className="region-pills config-region-pills">
            {REGIONS.map((r) => (
              <button
                key={r}
                type="button"
                className={region === r ? 'region-pill region-pill-active' : 'region-pill'}
                onClick={() => setRegion(r)}
              >
                {r}
              </button>
            ))}
          </div>
        )}

        <details className="hint advanced-scope">
          <summary>Advanced scope (sales org, as-of date)</summary>
          <div className="field-grid">
            <Field label="Sales org (* = region-wide default)">
              <input value={salesOrg} onChange={(e) => setSalesOrg(e.target.value)} />
            </Field>
            <Field label="As of (blank = today)">
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </Field>
          </div>
        </details>

        {section === 'Region pricing' && <RegionConfigSection user={user} region={region} salesOrg={salesOrg} asOf={asOf} />}
        {section === 'Suppliers' && <SupplierConfigSection user={user} region={region} salesOrg={salesOrg} asOf={asOf} />}
        {section === 'Routing' && <RegionRouteSection user={user} salesOrg={salesOrg} asOf={asOf} />}
        {section === 'Customers' && <PartyConfigSection user={user} asOf={asOf} />}
        {section === 'AI suggestions' && <AiSuggestionsSection user={user} region={region} salesOrg={salesOrg} />}
      </section>
    </main>
  );
}
