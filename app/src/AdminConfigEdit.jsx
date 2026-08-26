import { Fragment, useState } from 'react';
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

/** "a && b" <-> when arrays: the row state holds one text representation; multiple AND-ed
 *  conditions are written with " && " between them, matching the read-only view. The
 *  structured builder below edits the same text, so both stay in sync. */
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

/** The request-item fields `when` conditions actually branch on today — the picker offers
 *  these, plus a free-text option for anything else the engine's grammar allows. */
const WHEN_FIELDS = [
  'item.stockClass',
  'item.coo',
  'item.ood',
  'item.supplier',
  'item.supplierCountry',
  'item.warehouse',
  'item.includeMarkup',
  'item.includeLandedCost',
  'item.includeTariff',
  'item.includePick',
];

/** One side of the engine's single-comparison grammar: "path OP literal". Returns null for
 *  anything that doesn't parse — the builder then falls back to free text for that condition. */
function parseCondition(expr) {
  const m = String(expr).trim().match(/^(\S+)\s*(===|!==)\s*(.+)$/);
  if (!m) return null;
  let value = m[3].trim();
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1);
  }
  return { field: m[1], op: m[2], value };
}

function serializeCondition(c) {
  const raw = String(c.value).trim();
  const bare = ['true', 'false', 'null'].includes(raw) || (raw !== '' && !Number.isNaN(Number(raw)));
  return `${c.field} ${c.op} ${bare ? raw : `'${raw}'`}`;
}

/** Structured editor for one element's `when`: condition rows (field / is / is not / value),
 *  AND-ed together. Conditions that don't fit the simple grammar stay editable as raw text. */
function WhenBuilder({ text, onChange }) {
  const parts = text.trim() ? text.split('&&').map((p) => p.trim()).filter(Boolean) : [];
  const conditions = parts.map((p) => ({ raw: p, parsed: parseCondition(p) }));

  const emit = (next) => {
    onChange(next.map((c) => (c.parsed ? serializeCondition(c.parsed) : c.raw)).join(' && '));
  };
  const updateParsed = (i, key, value) => {
    const next = conditions.map((c, ci) => (ci === i ? { ...c, parsed: { ...c.parsed, [key]: value } } : c));
    emit(next);
  };
  const updateRaw = (i, value) => {
    const next = conditions.map((c, ci) => (ci === i ? { raw: value, parsed: null } : c));
    onChange(next.map((c) => (c.parsed ? serializeCondition(c.parsed) : c.raw)).join(' && '));
  };
  const remove = (i) => emit(conditions.filter((_, ci) => ci !== i));
  const add = () => emit([...conditions, { parsed: { field: WHEN_FIELDS[0], op: '===', value: '' } }]);

  return (
    <div className="when-builder">
      <p className="hint">
        This element only applies when <strong>all</strong> conditions below are true. No conditions = always applies.
      </p>
      {conditions.map((c, i) => (
        <div className="when-condition-row" key={i}>
          {c.parsed ? (
            <>
              <select
                value={WHEN_FIELDS.includes(c.parsed.field) ? c.parsed.field : '__custom__'}
                onChange={(e) => {
                  if (e.target.value === '__custom__') updateRaw(i, serializeCondition(c.parsed));
                  else updateParsed(i, 'field', e.target.value);
                }}
              >
                {WHEN_FIELDS.map((f) => <option key={f} value={f}>{f.replace('item.', '')}</option>)}
                {!WHEN_FIELDS.includes(c.parsed.field) && <option value={c.parsed.field}>{c.parsed.field}</option>}
                <option value="__custom__">custom expression…</option>
              </select>
              <select value={c.parsed.op} onChange={(e) => updateParsed(i, 'op', e.target.value)}>
                <option value="===">is</option>
                <option value="!==">is not</option>
              </select>
              <input value={c.parsed.value} onChange={(e) => updateParsed(i, 'value', e.target.value)} placeholder="value, e.g. NonMTS or false" />
            </>
          ) : (
            <input className="when-raw" value={c.raw} onChange={(e) => updateRaw(i, e.target.value)} placeholder="custom expression, e.g. item.coo === 'US'" />
          )}
          <button type="button" className="row-remove" onClick={() => remove(i)} aria-label="Remove condition">×</button>
        </div>
      ))}
      <button type="button" className="link-button" onClick={add}>+ Add condition</button>
    </div>
  );
}

function numberOrString(value) {
  const trimmed = String(value).trim();
  if (trimmed === '') return undefined;
  return Number.isNaN(Number(trimmed)) ? trimmed : Number(trimmed);
}

const ELEMENT_TYPES = ['BASE', 'FACTOR', 'ADDER', 'PER_LINE'];
/** Plain-language labels for the element types — the enum values read as engine jargon. */
const ELEMENT_TYPE_LABEL = {
  BASE: 'Base cost',
  FACTOR: 'Markup ×',
  ADDER: 'Charge +',
  PER_LINE: 'Per-order charge',
};
const CONSTRAINT_KINDS = ['FLOOR', 'STEP', 'MIN_QTY'];
const CONSTRAINT_KIND_LABEL = {
  FLOOR: 'Minimum value (MOLV)',
  STEP: 'Round to step',
  MIN_QTY: 'Minimum qty (MOQ, info only)',
};

/** A FACTOR rate like 0.047 reads as 4.7% for the business user. */
function ratePercentHint(rate) {
  const n = Number(String(rate).trim());
  if (String(rate).trim() === '' || Number.isNaN(n)) return null;
  return `${(n * 100).toFixed(n * 100 % 1 === 0 ? 0 : 1)}%`;
}

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
export function RegionConfigEditor({ user, region, salesOrg, baseConfig, defaultVersion, onSaved, onCancel }) {
  const [version, setVersion] = useState(defaultVersion || '');
  const [validFrom, setValidFrom] = useState('');
  const [buildUpRows, setBuildUpRows] = useState(() => buildUpToRows(baseConfig.buildUp));
  const [constraintRows, setConstraintRows] = useState(() => constraintsToRows(baseConfig.constraints));
  const [costAccessSequence, setCostAccessSequence] = useState((baseConfig.costAccessSequence || []).join(', '));
  const [stockClassRows, setStockClassRows] = useState(() =>
    Object.entries(baseConfig.stockClassMap || {}).map(([raw, canonical]) => ({ raw, canonical })));
  const [acmRows, setAcmRows] = useState(() =>
    Object.entries(baseConfig.additionalCostMap || {}).map(([flag, m]) => ({
      flag,
      markup: m.markup !== false,
      landedCost: m.landedCost !== false,
      tariff: m.tariff !== false,
      pick: m.pick !== false,
    })));
  const [resolution, setResolution] = useState(baseConfig.resolution ? JSON.stringify(baseConfig.resolution.map(({ provenance, ...r }) => r), null, 2) : '');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [whenOpenIndex, setWhenOpenIndex] = useState(null);

  const updateBuildUpRow = (i, key, value) => setBuildUpRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  const updateConstraintRow = (i, key, value) => setConstraintRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  const updateStockClassRow = (i, key, value) => setStockClassRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  const updateAcmRow = (i, key, value) => setAcmRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));

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
    const scmEntries = stockClassRows.filter((r) => r.raw.trim());
    if (scmEntries.length > 0) doc.stockClassMap = Object.fromEntries(scmEntries.map((r) => [r.raw.trim(), r.canonical]));
    const acmEntries = acmRows.filter((r) => String(r.flag).trim());
    if (acmEntries.length > 0) {
      doc.additionalCostMap = Object.fromEntries(acmEntries.map((r) => [
        String(r.flag).trim(),
        { markup: r.markup, landedCost: r.landedCost, tariff: r.tariff, pick: r.pick },
      ]));
    }
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
      <h3>{region} configuration <span className="hint-inline">(currently v{baseConfig.version} — saving creates a new version, pricing uses it immediately)</span></h3>

      <h4>Pricing steps</h4>
      <p className="hint">The price of every line is built top to bottom: the base cost, then each markup and charge that applies. Change a value and save — the old version stays in history.</p>
      <div className="item-grid-scroll">
        <table className="item-grid edit-grid">
          <thead>
            <tr><th>Step</th><th>Type</th><th title="Markups only — which earlier steps the percentage applies to; click to toggle">Applies to</th><th title="Multiplier for a markup, e.g. 0.047 = 4.7%">Rate</th><th title="Read the rate from the part's data instead of a fixed number">Rate from data</th><th title="Fixed amount for a charge">Amount</th><th title="Read the amount from the part's data (e.g. freight, duty, pickCharge)">Amount from data</th><th title="Conditions that must all be true for this step to apply">Applies when</th><th aria-hidden="true"></th></tr>
          </thead>
          <tbody>
            {buildUpRows.map((row, i) => {
              const priorIds = buildUpRows.slice(0, i).map((r) => r.id.trim()).filter(Boolean);
              const basisIds = row.basis.split(',').map((b) => b.trim()).filter(Boolean);
              const toggleBasis = (id) => updateBuildUpRow(
                i,
                'basis',
                (basisIds.includes(id) ? basisIds.filter((b) => b !== id) : [...basisIds, id]).join(', '),
              );
              const whenSummary = row.when.trim()
                ? row.when.split('&&').map((p) => p.trim()).filter(Boolean).length
                : 0;
              return (
                <Fragment key={i}>
                  <tr>
                    <td><input value={row.id} onChange={(e) => updateBuildUpRow(i, 'id', e.target.value)} /></td>
                    <td>
                      <select value={row.type} onChange={(e) => updateBuildUpRow(i, 'type', e.target.value)}>
                        {ELEMENT_TYPES.map((t) => <option key={t} value={t}>{ELEMENT_TYPE_LABEL[t]}</option>)}
                      </select>
                    </td>
                    <td>
                      {row.type === 'FACTOR' ? (
                        <div className="basis-chips">
                          {priorIds.map((id) => (
                            <button
                              key={id}
                              type="button"
                              className={basisIds.includes(id) ? 'basis-chip basis-chip-on' : 'basis-chip'}
                              onClick={() => toggleBasis(id)}
                            >
                              {id}
                            </button>
                          ))}
                          {priorIds.length === 0 && <span className="hint">no earlier steps</span>}
                        </div>
                      ) : (
                        <span className="hint">—</span>
                      )}
                    </td>
                    <td>
                      <div className="rate-cell">
                        <input className="qty-input" value={row.rate} onChange={(e) => updateBuildUpRow(i, 'rate', e.target.value)} />
                        {row.type === 'FACTOR' && ratePercentHint(row.rate) && <span className="rate-hint">= {ratePercentHint(row.rate)}</span>}
                      </div>
                    </td>
                    <td><input value={row.rateRef} onChange={(e) => updateBuildUpRow(i, 'rateRef', e.target.value)} /></td>
                    <td><input className="qty-input" value={row.amount} onChange={(e) => updateBuildUpRow(i, 'amount', e.target.value)} /></td>
                    <td><input value={row.amountRef} onChange={(e) => updateBuildUpRow(i, 'amountRef', e.target.value)} /></td>
                    <td>
                      <button
                        type="button"
                        className="kit-toggle"
                        onClick={() => setWhenOpenIndex((cur) => (cur === i ? null : i))}
                      >
                        {whenSummary === 0 ? 'always' : `${whenSummary} condition${whenSummary === 1 ? '' : 's'}`}
                        {whenOpenIndex === i ? ' ▾' : ' ▸'}
                      </button>
                    </td>
                    <td><button type="button" className="row-remove" onClick={() => { setWhenOpenIndex(null); setBuildUpRows((rows) => rows.filter((_, idx) => idx !== i)); }} aria-label="Remove row">×</button></td>
                  </tr>
                  {whenOpenIndex === i && (
                    <tr className="kit-editor-row">
                      <td colSpan={9}>
                        <div className="kit-editor">
                          <WhenBuilder text={row.when} onChange={(text) => updateBuildUpRow(i, 'when', text)} />
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
      <button type="button" className="link-button" onClick={() => setBuildUpRows((rows) => [...rows, newBuildUpRow()])}>+ Add build-up element</button>

      <h4>Order rules (minimums, floors)</h4>
      <div className="item-grid-scroll">
        <table className="item-grid edit-grid">
          <thead>
            <tr><th>Rule</th><th>Kind</th><th title="For a minimum value: adjust the PRICE up (default), or bump the QUANTITY instead">Adjusts</th><th>Minimum</th><th title="Read the minimum from the part's data (e.g. molv, moq)">Minimum from data</th><th>Step</th><th>Step from data</th><th aria-hidden="true"></th></tr>
          </thead>
          <tbody>
            {constraintRows.map((row, i) => (
              <tr key={i}>
                <td><input value={row.id} onChange={(e) => updateConstraintRow(i, 'id', e.target.value)} /></td>
                <td>
                  <select value={row.kind} onChange={(e) => updateConstraintRow(i, 'kind', e.target.value)}>
                    {CONSTRAINT_KINDS.map((k) => <option key={k} value={k}>{CONSTRAINT_KIND_LABEL[k]}</option>)}
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

      <h4>Stock class map</h4>
      <p className="hint">Maps this region's raw ERP stock-class codes to MTS / Non-MTS. Leave empty if this region doesn't classify by stock class.</p>
      <table className="item-grid edit-grid-narrow">
        <thead>
          <tr><th>Raw ERP code</th><th>Classifies as</th><th aria-hidden="true"></th></tr>
        </thead>
        <tbody>
          {stockClassRows.map((row, i) => (
            <tr key={i}>
              <td><input value={row.raw} onChange={(e) => updateStockClassRow(i, 'raw', e.target.value)} placeholder="e.g. OMT" /></td>
              <td>
                <select value={row.canonical} onChange={(e) => updateStockClassRow(i, 'canonical', e.target.value)}>
                  <option value="MTS">MTS</option>
                  <option value="NonMTS">NonMTS</option>
                </select>
              </td>
              <td><button type="button" className="row-remove" onClick={() => setStockClassRows((rows) => rows.filter((_, idx) => idx !== i))} aria-label="Remove row">×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="link-button" onClick={() => setStockClassRows((rows) => [...rows, { raw: '', canonical: 'MTS' }])}>+ Add code</button>

      <h4>Additional cost map</h4>
      <p className="hint">For each value of the line-level Additional Cost flag, which charges apply. Leave empty if this region doesn't use the flag.</p>
      <table className="item-grid edit-grid-narrow">
        <thead>
          <tr><th>Flag value</th><th>Markup</th><th>Landed cost (freight+duty)</th><th>Tariff</th><th>Pick</th><th aria-hidden="true"></th></tr>
        </thead>
        <tbody>
          {acmRows.map((row, i) => (
            <tr key={i}>
              <td><input className="qty-input" value={row.flag} onChange={(e) => updateAcmRow(i, 'flag', e.target.value)} placeholder="e.g. 0" /></td>
              {['markup', 'landedCost', 'tariff', 'pick'].map((key) => (
                <td key={key} className="checkbox-cell">
                  <input type="checkbox" checked={row[key]} onChange={(e) => updateAcmRow(i, key, e.target.checked)} />
                </td>
              ))}
              <td><button type="button" className="row-remove" onClick={() => setAcmRows((rows) => rows.filter((_, idx) => idx !== i))} aria-label="Remove row">×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="link-button" onClick={() => setAcmRows((rows) => [...rows, { flag: '', markup: true, landedCost: true, tariff: true, pick: true }])}>+ Add flag value</button>

      <h4>Resolution ladder (advanced, JSON)</h4>
      <div className="json-editors">
        <label className="field">
          <span>Documentation-only today — not read by the pricing engine (cost-source resolution happens in API6)</span>
          <textarea rows={5} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder='[{"id": "RES_1", "costBasis": "MOVING_AVG"}]' />
        </label>
      </div>

      {error && <p className="error">{error}</p>}
      <div className="save-bar">
        <Field label="Save as version">
          <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. 2026.08.1" />
        </Field>
        <Field label="Effective from (blank = today)">
          <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </Field>
        <div className="editor-actions">
          <button type="button" onClick={save} disabled={saving || !version.trim()}>{saving ? 'Saving…' : 'Save configuration'}</button>
          {onCancel && <button type="button" className="link-button" onClick={onCancel}>Reset</button>}
        </div>
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
