import { Fragment, useEffect, useState } from 'react';
import {
  DEMO_USERS,
  ApiError,
  getEffectiveConfig,
  listVersions,
  getEffectiveSupplierConfig,
  listSuppliers,
} from './api';
import { RegionConfigEditor, SupplierConfigEditor } from './AdminConfigEdit.jsx';

const REGIONS = ['EUROPE', 'CHINA', 'INDIA', 'AMERICAS'];
// Routing (region-route), Customers (party-config), and AI suggestions were removed from this
// UI per owner request ("what is routing, customer and AI suggestion. I dont need it") — the
// backend tables/endpoints/tests are untouched (resolveRegion() in srv/pricing-service.js
// still uses region-route/party-config whenever a caller omits `region`, and the AI-suggestion
// pipeline is still there for when ANTHROPIC_API_KEY is configured), this only drops the
// admin browse/edit screens nobody was using.
const ADMIN_SECTIONS = ['Region pricing', 'Suppliers'];

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

/** A supplier is independent of region: it manufactures in one country and ships to
 *  warehouses across every region that orders from it. supplierCountry/MOLV/MOQ are
 *  supplier-wide; freight/duty/tariff vary by destination warehouse, so they render as a
 *  per-warehouse table rather than flat columns. No region/salesOrg scoping — a supplier
 *  either has a document on file or it doesn't. */
function SupplierConfigSection({ user, asOf }) {
  const isAdmin = user === 'bob';
  const [supplier, setSupplier] = useState('ACME');
  const [supplierList, setSupplierList] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [savedNote, setSavedNote] = useState(null);
  const [listTick, setListTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listSuppliers({ user, asOf })
      .then((res) => { if (!cancelled) setSupplierList(res.suppliers || []); })
      .catch(() => { if (!cancelled) setSupplierList([]); });
    return () => { cancelled = true; };
  }, [user, asOf, listTick]);

  const load = async (supplierId = supplier) => {
    setLoading(true);
    setError(null);
    setResult(null);
    setNotFound(false);
    setEditing(false);
    try {
      const config = await getEffectiveSupplierConfig({ user, supplier: supplierId, asOf });
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
      <p className="hint">
        A supplier is independent of region — it manufactures goods in one country and ships to
        warehouses in whichever regions order from it. Supplier country, MOLV and MOQ are
        supplier-wide; freight, duty and tariff vary by <em>destination warehouse</em> — a line
        that names both a supplier and a warehouse prices with that specific row's numbers.
      </p>

      {supplierList.length > 0 && (
        <table className="results-table">
          <thead>
            <tr><th>Supplier</th><th>Country</th><th className="num">MOLV</th><th className="num">MOQ</th><th>Warehouses</th></tr>
          </thead>
          <tbody>
            {supplierList.map((s) => (
              <tr
                key={s.supplier}
                className="results-row"
                onClick={() => { setSupplier(s.supplier); load(s.supplier); }}
                title="Click to open this supplier"
              >
                <td className="mono">{s.supplier}</td>
                <td className="mono">{s.supplierCountry ?? '—'}</td>
                <td className="num mono">{s.molv ?? '—'}</td>
                <td className="num mono">{s.moq ?? '—'}</td>
                <td className="mono">{s.warehouses && Object.keys(s.warehouses).length > 0 ? Object.keys(s.warehouses).join(', ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="field-grid">
        <Field label="Supplier (click a row above, or type a new id to create one)">
          <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. ACME" />
        </Field>
      </div>
      <button type="button" onClick={() => load()} disabled={loading || !supplier.trim()}>
        {loading ? 'Loading…' : `Look up ${supplier || '…'}`}
      </button>
      {error && <p className="error">{error}</p>}
      {savedNote && <p className="hint">{savedNote}</p>}
      {notFound && <p className="missing-reason">No effective supplier-config for "{supplier}".</p>}

      {isAdmin && (result || notFound) && !editing && (
        <button type="button" onClick={() => { setEditing(true); setSavedNote(null); }}>
          {result ? 'Edit as new version' : 'Create supplier config'}
        </button>
      )}

      {result && !editing && (
        <>
          <dl className="config-meta">
            <div><dt>Version</dt><dd className="mono">{result.version}</dd></div>
            <div><dt>Valid from</dt><dd className="mono">{result.validFrom}</dd></div>
            <div><dt>Supplier country</dt><dd className="mono">{result.supplierCountry ?? '—'}</dd></div>
            <div><dt>MOLV</dt><dd className="mono">{result.molv ?? '—'}</dd></div>
            <div><dt>MOQ</dt><dd className="mono">{result.moq ?? '—'}</dd></div>
          </dl>
          <h4>Warehouses</h4>
          {result.warehouses && Object.keys(result.warehouses).length > 0 ? (
            <table className="trace-table">
              <thead><tr><th>Warehouse</th><th className="num">Freight</th><th className="num">Duty</th><th className="num">Tariff</th></tr></thead>
              <tbody>
                {Object.entries(result.warehouses).map(([code, terms]) => (
                  <tr key={code}>
                    <td className="mono">{code}</td>
                    <td className="num mono">{terms.freight ?? '—'}</td>
                    <td className="num mono">{terms.duty ?? '—'}</td>
                    <td className="num mono">{terms.tariff ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint">No per-warehouse charges declared — a line shipped to any warehouse falls back to whatever API6 already put in facts.</p>
          )}
        </>
      )}

      {editing && (
        <SupplierConfigEditor
          user={user}
          supplier={supplier}
          base={result}
          onSaved={(saved) => { setSavedNote(`Saved version ${saved.version} — now ACTIVE.`); setListTick((t) => t + 1); load(); }}
          onCancel={() => setEditing(false)}
        />
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

  // Suppliers are global (independent of region) — the region pills don't apply there.
  const regionMatters = section === 'Region pricing';

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
        {section === 'Suppliers' && <SupplierConfigSection user={user} asOf={asOf} />}
      </section>
    </main>
  );
}
