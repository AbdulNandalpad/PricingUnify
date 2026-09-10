import { useState } from 'react';
import * as api from '../api.js';
import { CONSTRAINT_LABEL, TYPE_LABEL, humanWhen, pct } from '../format.js';
import { Chip, Empty, ErrorBox, Loading, Panel } from '../components/ui.jsx';
import WhenBuilder from '../components/WhenBuilder.jsx';
import { REGIONS } from '../calculator/useQuote.js';
import { useDraft } from './drafts.js';
import { NumInput, PctInput, TextInput } from './editors.jsx';

function SheetStatus({ draft }) {
  if (draft.saving) return <span className="saving">saving draft…</span>;
  if (draft.hasDraft) return <Chip kind="warn">draft v{draft.draft.version}</Chip>;
  if (draft.live) return <Chip kind="good">live v{draft.live.version}</Chip>;
  return null;
}

function seqList(seq) { return Array.isArray(seq) ? { '*': seq } : seq || {}; }

/** Cost source order: one row per stock class key, edited as a comma list. */
function CostOrder({ doc, update, disabled }) {
  const seq = seqList(doc.costAccessSequence);
  const setKey = (k, text) => update((d) => {
    const cur = seqList(d.costAccessSequence);
    cur[k] = text.split(/[,\s→]+/).map((s) => s.trim()).filter(Boolean);
    d.costAccessSequence = Object.keys(cur).length === 1 && cur['*'] ? cur['*'] : cur;
  });
  const addKey = (k) => update((d) => { const cur = seqList(d.costAccessSequence); if (!cur[k]) cur[k] = cur['*'] ? [...cur['*']] : []; d.costAccessSequence = cur; });
  return (
    <Panel title="Where the cost comes from" sub="first system with a cost wins" mb={false}>
      <div className="body">
        {Object.entries(seq).map(([k, s]) => (
          <div className="seq-row" key={k}>
            <span className="label">{k === '*' ? 'Default' : k}</span>
            {disabled ? <span className="seq">{s.map((x, j) => <span key={j}><span className="s">{x}</span>{j < s.length - 1 ? <span className="arr"> → </span> : null}</span>)}</span>
              : <span className="seq"><TextInput className="mono" value={s.join(' → ')} onChange={(t) => setKey(k, t)} ariaLabel={`Cost order ${k}`} /></span>}
          </div>
        ))}
        {!disabled && ['MTS', 'NonMTS'].filter((k) => !seq[k]).map((k) => <button key={k} type="button" className="btn link small" style={{ marginRight: 10 }} onClick={() => addKey(k)}>+ own order for {k}</button>)}
        <div className="note">A user's manual cost on the quote line (C4C) still wins when they pick it. Which system was actually used is always named in the price trace.</div>
      </div>
    </Panel>
  );
}

function BuildUp({ doc, update, disabled, currency }) {
  const [editWhen, setEditWhen] = useState(null);
  const [newId, setNewId] = useState('');
  const rows = doc.buildUp || [];
  const setEl = (i, patch) => update((d) => { d.buildUp[i] = { ...d.buildUp[i], ...patch }; });
  const addStep = () => {
    const id = newId.trim().toUpperCase().replace(/\W+/g, '_');
    if (!id || rows.some((r) => r.id === id)) return;
    update((d) => { d.buildUp.push({ id, type: 'FACTOR', basis: ['BASE_COST'], rate: 0.02 }); });
    setNewId('');
  };
  return (
    <Panel title={`Landed cost build-up · ${doc.region}`} actions={!disabled && (
      <span className="inline-form">
        <input type="text" className="mono" placeholder="NEW_FACTOR" value={newId} onChange={(e) => setNewId(e.target.value)} aria-label="New step id" style={{ width: 160 }} onKeyDown={(e) => { if (e.key === 'Enter') addStep(); }} />
        <button type="button" className="btn small" onClick={addStep} disabled={!newId.trim()}>+ Add step</button>
      </span>
    )}>
      <div className="scroll">
        <table>
          <thead><tr><th>Step</th><th>Type</th><th>Applies to</th><th>Rate / amount</th><th>When</th><th></th></tr></thead>
          <tbody>
            {rows.map((el, i) => {
              const earlier = rows.slice(0, i).map((r) => r.id);
              const basis = el.basis || [];
              return (
                <tr key={el.id}>
                  <td className="mono">{el.id}</td>
                  <td>
                    {el.type === 'BASE' || disabled ? <span className="type-b">{TYPE_LABEL[el.type] || el.type}</span>
                      : <select value={el.type} aria-label="Step type" onChange={(e) => { const type = e.target.value; setEl(i, { type, ...(type === 'FACTOR' ? { basis: basis.length ? basis : ['BASE_COST'], rate: el.rate ?? (el.rateRef ? undefined : 0), amount: undefined, amountRef: undefined } : { basis: undefined, rate: undefined, rateRef: undefined, amount: el.amount ?? (el.amountRef ? undefined : 0) }) }); }}>
                        {['FACTOR', 'ADDER', 'PER_LINE'].map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                      </select>}
                    {el.composite ? <span className="small muted"> composite</span> : null}
                  </td>
                  <td>
                    {el.type === 'FACTOR' ? (
                      <div className="basis">
                        {basis.map((b) => <span className="b" key={b}>{b}{!disabled && basis.length > 1 && <button type="button" onClick={() => setEl(i, { basis: basis.filter((x) => x !== b) })} aria-label={`Remove ${b}`}>×</button>}</span>)}
                        {!disabled && earlier.some((e) => !basis.includes(e)) && (
                          <select className="add" value="" aria-label="Add to basis" onChange={(e) => { if (e.target.value) setEl(i, { basis: [...basis, e.target.value] }); }}>
                            <option value="">+ add</option>{earlier.filter((e) => !basis.includes(e)).map((e) => <option key={e} value={e}>{e}</option>)}
                          </select>
                        )}
                      </div>
                    ) : el.type === 'PER_LINE' ? <span className="small muted">÷ quantity</span> : <span className="small muted">—</span>}
                  </td>
                  <td>
                    {el.type === 'BASE' ? <span className="small muted">resolved cost</span>
                      : el.type === 'FACTOR' ? (el.rate !== undefined && el.rate !== null
                        ? <PctInput value={el.rate} disabled={disabled} onChange={(v) => setEl(i, { rate: v })} ariaLabel={`${el.id} rate`} />
                        : <><span className="mono small">{el.rateRef} %</span> <span className="small muted">from part / supplier</span></>)
                        : (el.amount !== undefined && el.amount !== null
                          ? <><NumInput value={el.amount} step={1} disabled={disabled} onChange={(v) => setEl(i, { amount: v })} ariaLabel={`${el.id} amount`} /> <span className="small muted">{currency}</span></>
                          : <><span className="mono small">{el.amountRef}</span> <span className="small muted">from part data</span></>)}
                  </td>
                  <td>
                    <div className="when-cell">
                      <span className="when">{humanWhen(el.when)}</span>
                      {!disabled && el.type !== 'BASE' && <button type="button" className="btn link small" onClick={() => setEditWhen(editWhen === el.id ? null : el.id)}>{editWhen === el.id ? 'done' : 'edit'}</button>}
                      {editWhen === el.id && <WhenBuilder when={el.when} disabled={disabled} onChange={(w) => setEl(i, { when: w })} />}
                    </div>
                  </td>
                  <td>{!disabled && el.type !== 'BASE' && <button type="button" className="btn ghost small danger" onClick={() => update((d) => { d.buildUp.splice(i, 1); d.buildUp.forEach((r) => { if (r.basis) r.basis = r.basis.filter((b) => b !== el.id); }); })}>remove</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="body note">Order matters: each step is added on top of the running total, and a factor % is applied to exactly the steps listed under “applies to”. A step whose condition is not met contributes zero and still shows in the trace as “not applied”.</div>
    </Panel>
  );
}

function OrderRules({ doc, update, disabled }) {
  const cons = doc.constraints || [];
  return (
    <Panel title="Order rules" mb={false}>
      {cons.length === 0 ? <div className="body muted">No order rules in this region.</div> : (
        <div className="scroll"><table>
          <thead><tr><th>Rule</th><th>Meaning</th><th>When below the minimum</th><th>Minimum</th></tr></thead>
          <tbody>{cons.map((c, i) => (
            <tr key={c.id}>
              <td className="mono">{c.id}</td>
              <td>{CONSTRAINT_LABEL[c.kind] || c.kind}</td>
              <td>{c.kind === 'FLOOR' ? <select value={c.mode || 'PRICE'} disabled={disabled} aria-label="Floor mode" onChange={(e) => update((d) => { d.constraints[i].mode = e.target.value; })}><option value="PRICE">raise the unit price</option><option value="QUANTITY">raise the quantity</option></select> : '—'}</td>
              <td className="mono small">{c.min !== undefined && c.min !== null ? <NumInput value={c.min} disabled={disabled} onChange={(v) => update((d) => { d.constraints[i].min = v; })} ariaLabel="Minimum" /> : `${c.minRef} · from part / supplier`}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Panel>
  );
}

function StockClassMap({ doc, update, disabled }) {
  const [raw, setRaw] = useState('');
  const map = doc.stockClassMap;
  if (!map && disabled) return null;
  return (
    <Panel title="Stock class map" sub="ERP code → MTS / Non-MTS" mb={false}>
      <div className="body">
        <div className="applies">
          {Object.entries(map || {}).map(([k, v]) => (
            <span className="chip neutral" key={k}><span className="mono">{k}</span> →
              {disabled ? <span> {v}</span> : <select value={v} className="add" aria-label={`Class for ${k}`} onChange={(e) => update((d) => { d.stockClassMap[k] = e.target.value; })}><option>MTS</option><option>NonMTS</option></select>}
              {!disabled && <button type="button" className="x" onClick={() => update((d) => { delete d.stockClassMap[k]; })} aria-label={`Remove ${k}`}>×</button>}
            </span>
          ))}
          {!disabled && <span className="inline-form"><input type="text" className="mono" style={{ width: 90 }} placeholder="code" value={raw} onChange={(e) => setRaw(e.target.value)} aria-label="New raw code" /><button type="button" className="btn small" disabled={!raw.trim()} onClick={() => { update((d) => { d.stockClassMap = { ...(d.stockClassMap || {}), [raw.trim().toUpperCase()]: 'NonMTS' }; }); setRaw(''); }}>+ add</button></span>}
        </div>
        <div className="note">A part with an unmapped code is never priced silently — it comes back as Missing.</div>
      </div>
    </Panel>
  );
}

function AdditionalCost({ doc, update, disabled }) {
  const map = doc.additionalCostMap;
  if (!map) return null;
  const F = [['markup', 'Markup'], ['landedCost', 'Freight + duty'], ['tariff', 'Tariff'], ['pick', 'Pick']];
  return (
    <Panel title="Additional cost options" sub="the line-level selector in C4C" mb={false}>
      <div className="scroll"><table>
        <thead><tr><th>Option</th>{F.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
        <tbody>{Object.entries(map).map(([k, m]) => (
          <tr key={k}>
            <td>{k} – {disabled ? m.label : <TextInput value={m.label} onChange={(v) => update((d) => { d.additionalCostMap[k].label = v; })} ariaLabel={`Option ${k} label`} width={200} />}</td>
            {F.map(([f]) => <td key={f}><input type="checkbox" checked={Boolean(m[f])} disabled={disabled} aria-label={`${k} ${f}`} onChange={(e) => update((d) => { d.additionalCostMap[k][f] = e.target.checked; })} /></td>)}
          </tr>
        ))}</tbody>
      </table></div>
    </Panel>
  );
}

export default function RegionsSheet({ asOf, registry, isAdmin, region: initial }) {
  const [region, setRegion] = useState(REGIONS.includes(initial) ? initial : REGIONS[0]);
  const key = api.docKey('region-config', { region });
  const draft = useDraft({ kind: 'region-config', key, asOf, registry, isAdmin });
  const doc = draft.working;
  const disabled = !isAdmin;
  return (
    <>
      <div className="tabs sub" role="tablist">
        {REGIONS.map((r) => <button type="button" key={r} role="tab" aria-selected={r === region} className={r === region ? 'active' : ''} onClick={() => setRegion(r)}>{r}{registry.entries[`region-config|${api.docKey('region-config', { region: r })}`]?.draft ? <span className="chip warn">draft</span> : null}</button>)}
        <span style={{ marginLeft: 'auto', alignSelf: 'center' }}><SheetStatus draft={draft} /></span>
      </div>
      <ErrorBox error={draft.error} onRetry={draft.reload} />
      <ErrorBox error={draft.saveError} />
      {draft.loading && !doc && <Loading what={`Loading ${region}`} />}
      {!draft.loading && !doc && <Empty>No pricing rules exist for <b>{region}</b> as of {asOf}. {isAdmin ? 'Create one via the API or a seed; this screen edits existing documents.' : ''}</Empty>}
      {doc && (
        <>
          <div className="grid g2">
            <CostOrder doc={doc} update={draft.update} disabled={disabled} />
            <Panel title="Sell price" mb={false}>
              <div className="body">
                <dl className="kv">
                  <dt>Default margin</dt>
                  <dd>{doc.sell ? <><PctInput value={doc.sell.defaultMargin} disabled={disabled} onChange={(v) => draft.update((d) => { d.sell.defaultMargin = v; })} ariaLabel="Default margin" /> <span className="small muted">sell = landed ÷ (1 − margin); reps can adjust per line</span></> : <span className="muted">none — unit price = landed cost {!disabled && <button type="button" className="btn link small" onClick={() => draft.update((d) => { d.sell = { defaultMargin: 0.3 }; })}>add a default margin</button>}</span>}</dd>
                  <dt>Currency</dt><dd className="mono">{doc.currency || '—'}</dd>
                  <dt>Rounding</dt><dd className="mono">{doc.rounding ? `${String(doc.rounding.mode || 'HALF_UP').toLowerCase().replace('_', '-')}, ${doc.rounding.decimalPlaces ?? 2} dp` : 'half-up, 2 dp'}</dd>
                  <dt>Version</dt><dd className="mono small">{doc.status === 'DRAFT' ? `draft ${doc.version}` : `v${doc.version}`}{doc.sell?.defaultMargin !== undefined && draft.live?.sell?.defaultMargin !== undefined && draft.hasDraft && doc.sell.defaultMargin !== draft.live.sell.defaultMargin ? <span className="muted"> · live margin {pct(draft.live.sell.defaultMargin)}</span> : null}</dd>
                </dl>
              </div>
            </Panel>
          </div>
          <BuildUp doc={doc} update={draft.update} disabled={disabled} currency={doc.currency} />
          <div className="grid g2">
            <OrderRules doc={doc} update={draft.update} disabled={disabled} />
            <StockClassMap doc={doc} update={draft.update} disabled={disabled} />
            <AdditionalCost doc={doc} update={draft.update} disabled={disabled} />
          </div>
        </>
      )}
    </>
  );
}
