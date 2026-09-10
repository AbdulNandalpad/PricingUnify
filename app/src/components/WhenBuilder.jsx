/** Structured editor for a build-up step's `when` — kept from the previous app (owner-
 *  validated 2026-08-26): condition rows (field / is / is not / value) AND-ed together,
 *  serialised back to the engine's `"item.path OP literal"` strings. Anything outside that
 *  grammar stays editable as a raw expression. */
const WHEN_FIELDS = [
  'item.stockClass',
  'item.ood',
  'item.supplier',
  'item.supplierCountry',
  'item.warehouse',
  'item.includeMarkup',
  'item.includeLandedCost',
  'item.includeTariff',
  'item.includePick',
];

function parseCondition(expr) {
  const m = String(expr).trim().match(/^(\S+)\s*(===|!==|==|!=)\s*(.+)$/);
  if (!m) return null;
  let value = m[3].trim();
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
  return { field: m[1], op: m[2].startsWith('!') ? '!==' : '===', value };
}

function serializeCondition(c) {
  const raw = String(c.value).trim();
  const bare = ['true', 'false', 'null'].includes(raw) || (raw !== '' && !Number.isNaN(Number(raw)));
  return `${c.field} ${c.op} ${bare ? raw : `'${raw}'`}`;
}

/** `when` as stored (string | string[] | undefined) ↔ the builder's row list. */
function whenToList(when) {
  if (!when) return [];
  return (Array.isArray(when) ? when : [when]).map((raw) => ({ raw, parsed: parseCondition(raw) }));
}
function listToWhen(list) {
  const out = list.map((c) => (c.parsed ? serializeCondition(c.parsed) : c.raw)).filter((s) => s && s.trim());
  return out.length === 0 ? undefined : out.length === 1 ? out[0] : out;
}

export default function WhenBuilder({ when, onChange, disabled }) {
  const conditions = whenToList(when);
  const emit = (next) => onChange(listToWhen(next));
  const updateParsed = (i, key, value) => emit(conditions.map((c, ci) => (ci === i ? { ...c, parsed: { ...c.parsed, [key]: value } } : c)));
  const updateRaw = (i, value) => emit(conditions.map((c, ci) => (ci === i ? { raw: value, parsed: null } : c)));
  const remove = (i) => emit(conditions.filter((_, ci) => ci !== i));
  const add = () => emit([...conditions, { parsed: { field: WHEN_FIELDS[0], op: '===', value: '' } }]);

  return (
    <div className="when-builder">
      <div className="small muted">Applies only when <b>all</b> conditions hold. No conditions = always.</div>
      {conditions.map((c, i) => (
        <div className="when-condition-row" key={i}>
          {c.parsed ? (
            <>
              <select
                disabled={disabled}
                value={WHEN_FIELDS.includes(c.parsed.field) ? c.parsed.field : '__custom__'}
                onChange={(e) => (e.target.value === '__custom__' ? updateRaw(i, serializeCondition(c.parsed)) : updateParsed(i, 'field', e.target.value))}
              >
                {WHEN_FIELDS.map((f) => <option key={f} value={f}>{f.replace('item.', '')}</option>)}
                {!WHEN_FIELDS.includes(c.parsed.field) && <option value={c.parsed.field}>{c.parsed.field}</option>}
                <option value="__custom__">custom expression…</option>
              </select>
              <select disabled={disabled} value={c.parsed.op} onChange={(e) => updateParsed(i, 'op', e.target.value)}>
                <option value="===">is</option>
                <option value="!==">is not</option>
              </select>
              <input disabled={disabled} value={c.parsed.value} onChange={(e) => updateParsed(i, 'value', e.target.value)} placeholder="value, e.g. NonMTS or false" />
            </>
          ) : (
            <input disabled={disabled} className="mono" style={{ gridColumn: '1 / span 3' }} value={c.raw} onChange={(e) => updateRaw(i, e.target.value)} placeholder="custom expression, e.g. item.warehouse === 'US01'" />
          )}
          <button type="button" className="btn ghost small danger" disabled={disabled} onClick={() => remove(i)} aria-label="Remove condition">×</button>
        </div>
      ))}
      {!disabled && <button type="button" className="btn link small" style={{ marginTop: 6 }} onClick={add}>+ Add condition</button>}
    </div>
  );
}
