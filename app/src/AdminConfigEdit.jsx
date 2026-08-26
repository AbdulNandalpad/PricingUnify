import { useState } from 'react';
import { ApiError, saveRegionConfig, saveSupplierConfig, saveRegionRoute, savePartyConfig } from './api';

function editErrorMessage(err) {
  return err instanceof ApiError ? `${err.status}: ${err.message}` : err.message;
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** "a && b" <-> when arrays: the UI edits one text field; multiple AND-ed conditions are
 *  written with " && " between them, matching how the read-only view renders them. */
function whenToText(when) {
  if (!when) return '';
  return Array.isArray(when) ? when.join(' && ') : when;
}
function textToWhen(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split('&&').map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts : parts[0];
}

function numberOrString(value) {
  const trimmed = String(value).trim();
  if (trimmed === '') return undefined;
  return Number.isNaN(Number(trimmed)) ? trimmed : Number(trimmed);
}

const ELEMENT_TYPES = ['BASE', 'FACTOR', 'ADDER', 'PER_LINE'];
const CONSTRAINT_KINDS = ['FLOOR', 'STEP', 'MIN_QTY'];

function newBuildUpRow() {
  return { id: '', type: 'ADDER', basis: '', rate: '', rateRef: '', amount: '', amountRef: '', when: '' };
}
function newConstraintRow() {
  return { id: '', kind: 'FLOOR', mode: '', min: '', minRef: '', step: '', stepRef: '' };
}

function buildUpToRows(buildUp) {
  return (buildUp || []).map((el) => ({
    id: el.id,
    type: el.type,
    basis: (el.basis || []).join(', '),
    rate: el.rate ?? '',
    rateRef: el.rateRef ?? '',
    amount: el.amount ?? '',
    amountRef: el.amountRef ?? '',
    when: whenToText(el.when),
    composite: el.composite,
    allocatable: el.allocatable,
  }));
}
function constraintsToRows(constraints) {
  return (constraints || []).map((c) => ({
    id: c.id,
    kind: c.kind,
    mode: c.mode ?? '',
    min: c.min ?? '',
    minRef: c.minRef ?? '',
    step: c.step ?? '',
    stepRef: c.stepRef ?? '',
  }));
}

function rowsToBuildUp(rows) {
  return rows
    .filter((r) => r.id.trim())
    .map((r) => {
      const el = { id: r.id.trim(), type: r.type };
      const basis = r.basis.split(',').map((b) => b.trim()).filter(Boolean);
      if (basis.length > 0) el.basis = basis;
      const rate = numberOrString(r.rate);
      if (rate !== undefined) el.rate = rate;
      if (r.rateRef.trim()) el.rateRef = r.rateRef.trim();
      const amount = numberOrString(r.amount);
      if (amount !== undefined) el.amount = amount;
      if (r.amountRef.trim()) el.amountRef = r.amountRef.trim();
      const when = textToWhen(r.when);
      if (when !== undefined) el.when = when;
      if (r.composite !== undefined) el.composite = r.composite;
      if (r.allocatable !== undefined) el.allocatable = r.allocatable;
      return el;
    });
}
function rowsToConstraints(rows) {
  return rows
    .filter((r) => r.id.trim())
    .map((r) => {
      const c = { id: r.id.trim(), type: 'CONSTRAINT', kind: r.kind };
      if (r.mode) c.mode = r.mode;
      const min = numberOrString(r.min);
      if (min !== undefined) c.min = min;
      if (r.minRef.trim()) c.minRef = r.minRef.trim();
      const step = numberOrString(r.step);
      if (step !== undefined) c.step = step;
      if (r.stepRef.trim()) c.stepRef = r.stepRef.trim();
      return c;
    });
}

/** JSON side-fields (maps + resolution ladder) are edited as raw JSON for now — a structured
 *  per-map editor is a later refinement; invalid JSON blocks the save client-side with a
 *  clear message rather than sending garbage to the backend. */
function parseJsonField(label, text, errors) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    errors.push(`${label} is not valid JSON.`);
    return undefined;
  }
}

/**
 * Editable region-config: the current effective document's buildUp/constraints as editable
 * table rows, plus the maps as JSON. Saving always creates a brand-new version (config is
 * never mutated in place) — the backend stamps HUMAN provenance and re-validates everything,
 * including the FACTOR-basis rule, before anything goes live.
 */
export function RegionConfigEditor({ user, region, salesOrg, baseConfig, onSaved, onCancel }) {
  const [version, setVersion] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [buildUpRows, setBuildUpRows] = useState(() => buildUpToRows(baseConfig.buildUp));
  const [constraintRows, setConstraintRows] = useState(() => constraintsToRows(baseConfig.constraints));
  const [costAccessSequence, setCostAccessSequence] = useState((baseConfig.costAccessSequence || []).join(', '));
  const [stockClassMap, setStockClassMap] = useState(baseConfig.stockClassMap ? JSON.stringify(baseConfig.stockClassMap, null, 2) : '');
  const [additionalCostMap, setAdditionalCostMap] = useState(baseConfig.additionalCostMap ? JSON.stringify(baseConfig.additionalCostMap, null, 2) : '');
  const [resolution, setResolution] = useState(baseConfig.resolution ? JSON.stringify(baseConfig.resolution.map(({ provenance, ...r }) => r), null, 2) : '');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const updateBuildUpRow = (i, key, value) => setBuildUpRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  const updateConstraintRow = (i, key, value) => setConstraintRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));

  const save = async () => {
    setError(null);
    const clientErrors = [];
    if (!version.trim()) clientErrors.push('A new version id is required.');
    const doc = {
      region,
      salesOrg,
      version: version.trim(),
      supersedes: baseConfig.version,
      buildUp: rowsToBuildUp(buildUpRows),
      constraints: rowsToConstraints(constraintRows),
    };
    if (validFrom) doc.validFrom = validFrom;
    const seq = costAccessSequence.split(',').map((s) => s.trim()).filter(Boolean);
    if (seq.length > 0) doc.costAccessSequence = seq;
    const scm = parseJsonField('Stock class map', stockClassMap, clientErrors);
    if (scm !== undefined) doc.stockClassMap = scm;
    const acm = parseJsonField('Additional cost map', additionalCostMap, clientErrors);
    if (acm !== undefined) doc.additionalCostMap = acm;
    const res = parseJsonField('Resolution ladder', resolution, clientErrors);
    if (res !== undefined) doc.resolution = res;
    if (baseConfig.rounding) doc.rounding = baseConfig.rounding;
    if (baseConfig.fx) doc.fx = baseConfig.fx;

    if (clientErrors.length > 0) {
      setError(clientErrors.join(' '));
      return;
    }

    setSaving(true);
    try {
      const saved = await saveRegionConfig({ user, payload: doc });
      onSaved(saved);
    } catch (err) {
      setError(editErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-config-detail admin-editor">
      <h3>New version (based on {baseConfig.version})</h3>
      <p className="hint">
        Saving creates a brand-new effective-dated version — the current one is never modified. The backend
        re-validates everything (including that every FACTOR declares a valid basis) before it goes live.
      </p>

      <div className="field-grid">
        <Field label="New version id (required)">
          <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder={`e.g. ${new Date().getFullYear()}.${String(new Date().getMonth() + 1).padStart(2, '0')}.1`} />
        </Field>
        <Field label="Effective from (blank = today)">
          <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </Field>
      </div>

      <h4>Build-up</h4>
      <div className="item-grid-scroll">
        <table className="item-grid edit-grid">
          <thead>
            <tr><th>ID</th><th>Type</th><th>Basis (comma-sep)</th><th>Rate</th><th>Rate ref</th><th>Amount</th><th>Amount ref</th><th>When (use && for AND)</th><th aria-hidden="true"></th></tr>
          </thead>
          <tbody>
            {buildUpRows.map((row, i) => (
              <tr key={i}>
                <td><input value={row.id} onChange={(e) => updateBuildUpRow(i, 'id', e.target.value)} /></td>
                <td>
                  <select value={row.type} onChange={(e) => updateBuildUpRow(i, 'type', e.target.value)}>
                    {ELEMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td><input value={row.basis} onChange={(e) => updateBuildUpRow(i, 'basis', e.target.value)} placeholder="FACTOR only" /></td>
                <td><input className="qty-input" value={row.rate} onChange={(e) => updateBuildUpRow(i, 'rate', e.target.value)} /></td>
                <td><input value={row.rateRef} onChange={(e) => updateBuildUpRow(i, 'rateRef', e.target.value)} /></td>
                <td><input className="qty-input" value={row.amount} onChange={(e) => updateBuildUpRow(i, 'amount', e.target.value)} /></td>
                <td><input value={row.amountRef} onChange={(e) => updateBuildUpRow(i, 'amountRef', e.target.value)} /></td>
                <td><input value={row.when} onChange={(e) => updateBuildUpRow(i, 'when', e.target.value)} /></td>
                <td><button type="button" className="row-remove" onClick={() => setBuildUpRows((rows) => rows.filter((_, idx) => idx !== i))} aria-label="Remove row">×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="link-button" onClick={() => setBuildUpRows((rows) => [...rows, newBuildUpRow()])}>+ Add build-up element</button>

      <h4>Constraints</h4>
      <div className="item-grid-scroll">
        <table className="item-grid edit-grid">
          <thead>
            <tr><th>ID</th><th>Kind</th><th>Mode</th><th>Min</th><th>Min ref</th><th>Step</th><th>Step ref</th><th aria-hidden="true"></th></tr>
          </thead>
          <tbody>
            {constraintRows.map((row, i) => (
              <tr key={i}>
                <td><input value={row.id} onChange={(e) => updateConstraintRow(i, 'id', e.target.value)} /></td>
                <td>
                  <select value={row.kind} onChange={(e) => updateConstraintRow(i, 'kind', e.target.value)}>
                    {CONSTRAINT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </td>
                <td>
                  <select value={row.mode} onChange={(e) => updateConstraintRow(i, 'mode', e.target.value)}>
                    <option value="">PRICE (default)</option>
                    <option value="QUANTITY">QUANTITY</option>
                  </select>
                </td>
                <td><input className="qty-input" value={row.min} onChange={(e) => updateConstraintRow(i, 'min', e.target.value)} /></td>
                <td><input value={row.minRef} onChange={(e) => updateConstraintRow(i, 'minRef', e.target.value)} /></td>
                <td><input className="qty-input" value={row.step} onChange={(e) => updateConstraintRow(i, 'step', e.target.value)} /></td>
                <td><input value={row.stepRef} onChange={(e) => updateConstraintRow(i, 'stepRef', e.target.value)} /></td>
                <td><button type="button" className="row-remove" onClick={() => setConstraintRows((rows) => rows.filter((_, idx) => idx !== i))} aria-label="Remove row">×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="link-button" onClick={() => setConstraintRows((rows) => [...rows, newConstraintRow()])}>+ Add constraint</button>

      <h4>Cost access sequence</h4>
      <div className="field-grid">
        <Field label="Ordered systems (comma-separated, blank = none)">
          <input value={costAccessSequence} onChange={(e) => setCostAccessSequence(e.target.value)} placeholder="e.g. C4C, ERP, CCD, CCP" />
        </Field>
      </div>

      <h4>Maps &amp; resolution (JSON)</h4>
      <div className="json-editors">
        <label className="field">
          <span>Stock class map</span>
          <textarea rows={5} value={stockClassMap} onChange={(e) => setStockClassMap(e.target.value)} placeholder='{"OMT": "NonMTS", "MTS": "MTS"}' />
        </label>
        <label className="field">
          <span>Additional cost map</span>
          <textarea rows={5} value={additionalCostMap} onChange={(e) => setAdditionalCostMap(e.target.value)} placeholder='{"0": {"markup": false, ...}}' />
        </label>
        <label className="field">
          <span>Resolution ladder</span>
          <textarea rows={5} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder='[{"id": "RES_1", "costBasis": "MOVING_AVG"}]' />
        </label>
      </div>

      {error && <p className="error">{error}</p>}
      <div className="editor-actions">
        <button type="button" onClick={save} disabled={saving || !version.trim()}>{saving ? 'Saving…' : `Save as new ACTIVE version`}</button>
        <button type="button" className="link-button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Shared simple-document editor for supplier-config / region-route / party-config — a flat
 *  list of fields plus version/validFrom, saved as a new version via the matching endpoint. */
function SimpleDocEditor({ title, fields, fixed, save, onSaved, onCancel }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ''])));
  const [version, setVersion] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const payload = { ...fixed, version: version.trim() };
      if (validFrom) payload.validFrom = validFrom;
      for (const f of fields) {
        const v = String(values[f.key]).trim();
        if (v !== '') payload[f.key] = v;
      }
      const saved = await save(payload);
      onSaved(saved);
    } catch (err) {
      setError(editErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-config-detail admin-editor">
      <h3>{title}</h3>
      <div className="field-grid">
        <Field label="New version id (required)">
          <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. 2026.08.1" />
        </Field>
        <Field label="Effective from (blank = today)">
          <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </Field>
        {fields.map((f) => (
          <Field key={f.key} label={f.label}>
            <input
              value={values[f.key]}
              onChange={(e) => setValues((cur) => ({ ...cur, [f.key]: e.target.value }))}
              placeholder={f.placeholder || ''}
            />
          </Field>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="editor-actions">
        <button type="button" onClick={handleSave} disabled={saving || !version.trim()}>{saving ? 'Saving…' : 'Save as new ACTIVE version'}</button>
        <button type="button" className="link-button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function SupplierConfigEditor({ user, region, salesOrg, supplier, base, onSaved, onCancel }) {
  return (
    <SimpleDocEditor
      title={`New supplier-config version for ${region}/${salesOrg}/${supplier}${base ? ` (based on ${base.version})` : ''}`}
      fixed={{ region, salesOrg, supplier, ...(base ? { supersedes: base.version } : {}) }}
      fields={[
        { key: 'freight', label: 'Freight', initial: base?.freight ?? '' },
        { key: 'duty', label: 'Duty', initial: base?.duty ?? '' },
        { key: 'tariff', label: 'Tariff', initial: base?.tariff ?? '' },
        { key: 'molv', label: 'MOLV', initial: base?.molv ?? '' },
        { key: 'moq', label: 'MOQ', initial: base?.moq ?? '' },
        { key: 'supplierCountry', label: 'Supplier country', initial: base?.supplierCountry ?? '', placeholder: 'e.g. US' },
      ]}
      save={(payload) => saveSupplierConfig({ user, payload })}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}

export function RegionRouteEditor({ user, ood, salesOrg, base, onSaved, onCancel }) {
  return (
    <SimpleDocEditor
      title={`New region-route version for ${ood}/${salesOrg}${base ? ` (based on ${base.version})` : ''}`}
      fixed={{ ood, salesOrg, ...(base ? { supersedes: base.version } : {}) }}
      fields={[
        { key: 'region', label: 'Region (required)', initial: base?.region ?? '', placeholder: 'e.g. EUROPE' },
        { key: 'entityLabel', label: 'Entity label', initial: base?.entityLabel ?? '', placeholder: 'e.g. TSS Germany' },
      ]}
      save={(payload) => saveRegionRoute({ user, payload })}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}

export function PartyConfigEditor({ user, customerId, base, onSaved, onCancel }) {
  return (
    <SimpleDocEditor
      title={`New party-config version for ${customerId}${base ? ` (based on ${base.version})` : ''}`}
      fixed={{ customerId, ...(base ? { supersedes: base.version } : {}) }}
      fields={[
        { key: 'territory', label: 'Territory', initial: base?.territory ?? '' },
        { key: 'customerCountry', label: 'Customer country', initial: base?.customerCountry ?? '' },
        { key: 'customerCurrency', label: 'Customer currency', initial: base?.customerCurrency ?? '' },
        { key: 'customerOod', label: 'Customer OOD', initial: base?.customerOod ?? '', placeholder: 'e.g. SAP, SMA, CN, IN' },
      ]}
      save={(payload) => savePartyConfig({ user, payload })}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}
