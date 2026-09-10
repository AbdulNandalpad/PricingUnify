import { useState } from 'react';
import { describeMatch, ratePctInput, sameType } from '../format.js';

/** A rate stored as 0.047 edited as "4.7" %. Keeps the server's value type (string/number). */
export function PctInput({ value, onChange, disabled, step = 0.5, width = 84, ariaLabel = 'Percent' }) {
  const [text, setText] = useState(null);
  const shown = text ?? ratePctInput(value);
  return (
    <span className="tier">
      <input type="number" className="n" step={step} style={{ width }} value={shown} disabled={disabled} aria-label={ariaLabel}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text === null) return; const n = Number(text); if (text !== '' && Number.isFinite(n)) onChange(sameType(value, Math.round(n * 100) / 10000)); setText(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      <span className="small muted">%</span>
    </span>
  );
}

/** A plain number that keeps the server's type; commits on blur/Enter so typing is smooth. */
export function NumInput({ value, onChange, disabled, step = 0.01, width = 84, min, placeholder, ariaLabel = 'Number', className = 'n' }) {
  const [text, setText] = useState(null);
  const shown = text ?? (value === null || value === undefined ? '' : String(value));
  return (
    <input type="number" className={className} step={step} min={min} style={{ width }} value={shown} disabled={disabled} placeholder={placeholder} aria-label={ariaLabel}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (text === null) return; if (text === '') onChange(null); else { const n = Number(text); if (Number.isFinite(n)) onChange(sameType(value ?? 0, n)); } setText(null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}

/** Free text committed on blur/Enter. */
export function TextInput({ value, onChange, disabled, placeholder, className = '', width, ariaLabel = 'Text', list }) {
  const [text, setText] = useState(null);
  return (
    <input type="text" className={className} style={width ? { width } : undefined} value={text ?? (value ?? '')} disabled={disabled} placeholder={placeholder} aria-label={ariaLabel} list={list}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (text !== null && text !== (value ?? '')) onChange(text); setText(null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}

export function DateInput({ value, onChange, disabled, ariaLabel = 'Date', allowEmpty }) {
  return <input type="date" value={value || ''} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value || (allowEmpty ? null : value))} />;
}

/** `match` object editor — one input per declared dimension; blank = any. */
export function MatchInputs({ match, dimensions, onChange, disabled }) {
  return dimensions.map((d) => (
    <td key={d.attr}>
      <TextInput value={match?.[d.attr] ?? ''} disabled={disabled} placeholder="any" width={110} ariaLabel={d.label || d.attr}
        onChange={(v) => { const next = { ...(match || {}) }; if (v === '') delete next[d.attr]; else next[d.attr] = v; onChange(next); }} />
    </td>
  ));
}

/** Quantity tiers, inline: `from+ value` chips, add / remove. */
export function Tiers({ tiers = [], onChange, disabled }) {
  const set = (i, patch) => onChange(tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <div className="tiers">
      {tiers.map((t, i) => (
        <span className="chip neutral" key={i} style={{ gap: 4 }}>
          <NumInput value={t.from} step={1} min={0} width={56} disabled={disabled || i === 0} ariaLabel="Tier from" className="tier-in" onChange={(v) => set(i, { from: Number(v) })} />
          <span className="small muted">+</span>
          <NumInput value={t.value} step={0.01} width={70} disabled={disabled} ariaLabel="Tier value" className="tier-in" onChange={(v) => set(i, { value: v })} />
          {!disabled && i > 0 && <button type="button" className="x" onClick={() => onChange(tiers.filter((_, j) => j !== i))} aria-label="Remove tier">×</button>}
        </span>
      ))}
      {!disabled && <button type="button" className="btn ghost small" onClick={() => { const last = tiers.at(-1) || { from: 0, value: 0 }; onChange([...tiers, { from: (Number(last.from) || 0) * 2 || 100, value: last.value }]); }}>+ tier</button>}
    </div>
  );
}

export function ConditionText({ match }) {
  return <span>{describeMatch(match)}</span>;
}

/** Rows like discount/margin `[{match, value}]` shown as "Step · Condition · Rate %". */
export function RateRows({ label, rows = [], onChange, disabled, dims = [{ attr: 'tier', label: 'Tier' }, { attr: 'customer', label: 'Customer' }] }) {
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return rows.map((r, i) => (
    <tr key={i}>
      <td>{label}</td>
      <td>
        <div className="applies">
          <ConditionText match={r.match} />
          {!disabled && (
            <details className="inline-details"><summary className="btn link small">edit</summary>
              <table className="mini"><tbody><tr><MatchInputs match={r.match} dimensions={dims} onChange={(m) => set(i, { match: m })} disabled={disabled} /></tr></tbody></table>
            </details>
          )}
        </div>
      </td>
      <td className="num"><PctInput value={r.value} disabled={disabled} onChange={(v) => set(i, { value: v })} ariaLabel={`${label} rate`} /></td>
      <td>{!disabled && <button type="button" className="btn ghost small danger" onClick={() => onChange(rows.filter((_, j) => j !== i))}>remove</button>}</td>
    </tr>
  ));
}
