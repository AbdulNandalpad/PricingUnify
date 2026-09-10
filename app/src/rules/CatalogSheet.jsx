import { useEffect, useState } from 'react';
import * as api from '../api.js';
import { describeMatch } from '../format.js';
import { Chip, Empty, ErrorBox, Loading, Panel } from '../components/ui.jsx';
import { useDebounced } from '../hooks.js';
import { useDraft } from './drafts.js';
import { DateInput, NumInput, PctInput, RateRows, TextInput } from './editors.jsx';
import { BookPicker } from './PriceListsSheet.jsx';

/** Live server check of the fallback formula (`GET validateFormula`); the syntax hint is the
 *  only client-side knowledge — the verdict is always the server's. */
function FormulaCheck({ formula, bookId }) {
  const [res, setRes] = useState(null);
  const check = useDebounced(async (f) => {
    try { setRes((await api.validateFormula(f, 'catalog-book', bookId)) ?? { unavailable: true }); } catch (e) { setRes({ valid: false, message: api.describeError(e) }); }
  }, 400);
  useEffect(() => { if (formula) check(formula); }, [formula, check]);
  if (!res) return <span className="saving">checking…</span>;
  if (res.unavailable) return <Chip title="The backend has no validateFormula endpoint — the formula is checked on save">checked on save</Chip>;
  return <span className="tiers"><Chip kind={res.valid ? 'good' : 'crit'}>{res.valid ? 'valid' : 'invalid'}</Chip><span className="small muted">{res.message}</span></span>;
}

/** Cost inputs may be a single object or a list of effective-dated versions. */
function versionsOf(input) { return Array.isArray(input) ? input : [input]; }

export default function CatalogSheet({ asOf, registry, isAdmin }) {
  const books = registry.books['catalog-book'];
  const [id, setId] = useState(books[0]?.id || null);
  useEffect(() => { if (!id && books[0]) setId(books[0].id); }, [books, id]);
  const draft = useDraft({ kind: 'catalog-book', key: id, asOf, registry, isAdmin, enabled: Boolean(id) });
  const B = draft.working;
  const disabled = !isAdmin;
  const [newInput, setNewInput] = useState('');
  if (!id) return registry.scanning ? <Loading what="Loading catalogs" /> : <Empty>No catalog + formula book exists yet. Books are created through the API or a seed; this screen edits existing ones.</Empty>;
  const matchOn = B?.matchOn || ['spec', 'variant'];
  const inForce = (list) => list.find((v) => (!v.validFrom || v.validFrom <= asOf) && (!v.validTo || asOf < v.validTo)) || list.at(-1);
  return (
    <>
      <BookPicker books={books.map((b) => ({ ...b, draft: registry.entries[`catalog-book|${b.id}`]?.draft }))} value={id} onChange={setId} kind />
      <ErrorBox error={draft.error} onRetry={draft.reload} />
      <ErrorBox error={draft.saveError} />
      {draft.loading && !B && <Loading what="Loading catalog" />}
      {B && (
        <>
          <div className="grid g2">
            <Panel mb={false}
              title={<>{B.name} <Chip kind="cf">Catalog + formula</Chip>{draft.saving ? <span className="saving">saving draft…</span> : draft.hasDraft ? <Chip kind="warn">draft v{draft.draft.version}</Chip> : draft.live ? <Chip kind="good">live v{draft.live.version}</Chip> : null}</>}
              sub={`Applies when ${describeMatch(B.appliesWhen)} · ${B.currency}`}
              actions={!disabled && <button type="button" className="btn small" onClick={() => draft.update((d) => { d.rows.push({ match: Object.fromEntries(matchOn.map((k) => [k, ''])), rate: '0' }); })}>+ Add size</button>}
            >
              <div className="scroll"><table>
                <thead><tr>{matchOn.map((k) => <th key={k}>{k === 'spec' ? 'Size Ø' : k}</th>)}<th className="num">Negotiated rate</th><th></th></tr></thead>
                <tbody>{(B.rows || []).map((r, i) => (
                  <tr key={i}>
                    {matchOn.map((k) => <td key={k}><TextInput className="mono" value={r.match?.[k] ?? ''} width={100} disabled={disabled} ariaLabel={k} onChange={(v) => draft.update((d) => { d.rows[i].match = { ...(d.rows[i].match || {}), [k]: v }; })} /></td>)}
                    <td className="num"><NumInput value={r.rate} step={0.5} disabled={disabled} onChange={(v) => draft.update((d) => { d.rows[i].rate = v; })} ariaLabel="Rate" /></td>
                    <td>{!disabled && <button type="button" className="btn ghost small danger" onClick={() => draft.update((d) => { d.rows.splice(i, 1); })}>remove</button>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
              <div className="body note">A line whose exact size and variant is listed here gets this rate as its sell price. Anything else falls through to the formula.</div>
            </Panel>
            <Panel title="Fallback formula" mb={false} actions={<FormulaCheck formula={B.fallbackFormula} bookId={id} />}>
              <div className="body">
                <textarea className="mono" rows={2} style={{ width: '100%' }} value={B.fallbackFormula || ''} disabled={disabled} aria-label="Fallback formula" onChange={(e) => draft.update((d) => { d.fallbackFormula = e.target.value; })} />
                <div className="note">You can use <span className="mono">diameter_mm</span>, <span className="mono">quantity</span>, <span className="mono">spec</span> from the line, any <span className="mono">cost.*</span> input below, and <span className="mono">min / max / round / abs</span>. No other code runs — the formula is checked before it can go live.</div>
                <h3 className="label" style={{ margin: '14px 0 8px' }}>Cost inputs</h3>
                <div className="scroll"><table>
                  <thead><tr><th>Input</th><th className="num">Value</th><th>Unit</th><th>Valid from</th><th>Source</th><th></th></tr></thead>
                  <tbody>{Object.entries(B.costInputs || {}).map(([k, def]) => {
                    const list = versionsOf(def); const cur = inForce(list); const ci = list.indexOf(cur);
                    const set = (patch) => draft.update((d) => { const l = versionsOf(d.costInputs[k]); l[ci] = { ...l[ci], ...patch }; d.costInputs[k] = Array.isArray(d.costInputs[k]) ? l : l[0]; });
                    return (
                      <tr key={k}>
                        <td className="mono">cost.{k}{list.length > 1 && <div className="small muted">{list.length} dated versions · showing the one in force</div>}</td>
                        <td className="num"><NumInput value={cur?.value} disabled={disabled} onChange={(v) => set({ value: v })} ariaLabel={`${k} value`} /></td>
                        <td className="small"><TextInput value={cur?.unit ?? ''} width={110} disabled={disabled} onChange={(v) => set({ unit: v })} ariaLabel={`${k} unit`} /></td>
                        <td><DateInput value={cur?.validFrom} disabled={disabled} onChange={(v) => set({ validFrom: v })} ariaLabel={`${k} valid from`} /></td>
                        <td className="small muted">{disabled ? String(cur?.source || 'MANUAL').toLowerCase() : <select value={cur?.source || 'MANUAL'} aria-label={`${k} source`} onChange={(e) => set({ source: e.target.value })}><option>MANUAL</option><option>SUPPLIER</option><option>AI_DERIVED</option></select>}</td>
                        <td>{!disabled && <button type="button" className="btn ghost small danger" onClick={() => draft.update((d) => { delete d.costInputs[k]; })}>remove</button>}</td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
                {!disabled && (
                  <span className="inline-form" style={{ marginTop: 8 }}>
                    <input type="text" className="mono" placeholder="new input, e.g. steel_rate" value={newInput} onChange={(e) => setNewInput(e.target.value)} aria-label="New cost input" style={{ width: 200 }} />
                    <button type="button" className="btn small" disabled={!newInput.trim()} onClick={() => { const k = newInput.trim().replace(/^cost\./, '').replace(/\W+/g, '_'); draft.update((d) => { d.costInputs = { ...(d.costInputs || {}), [k]: { value: '0', unit: '', validFrom: asOf, source: 'MANUAL' } }; }); setNewInput(''); }}>+ Cost input</button>
                  </span>
                )}
                <div className="note">Cost inputs are effective-dated on their own: update a rate weekly without touching the formula or the catalog.</div>
              </div>
            </Panel>
          </div>
          <Panel title="From cost to price (formula lines only)" sub="catalog rates are already sell prices" actions={!disabled && <><button type="button" className="btn small" onClick={() => draft.update((d) => { d.margin = [...(d.margin || []), { match: {}, value: '0.2' }]; })}>+ Margin row</button><button type="button" className="btn small" onClick={() => draft.update((d) => { d.discount = [...(d.discount || []), { match: {}, value: 0 }]; })}>+ Discount row</button></>}>
            <div className="scroll"><table>
              <thead><tr><th>Step</th><th>Condition</th><th className="num">Rate</th><th></th></tr></thead>
              <tbody>
                <tr><td>Freight</td><td>flat per unit</td><td className="num"><NumInput value={B.freight ?? 0} disabled={disabled} onChange={(v) => draft.update((d) => { d.freight = v ?? 0; })} ariaLabel="Freight" /> <span className="small muted">{B.currency}</span></td><td /></tr>
                <RateRows label="Margin on landed cost" rows={B.margin || []} disabled={disabled} onChange={(rows) => draft.update((d) => { d.margin = rows; })} />
                <tr><td>Margin floor</td><td>after discount · breach → needs approval</td><td className="num"><PctInput value={B.floor ?? 0} disabled={disabled} onChange={(v) => draft.update((d) => { d.floor = v; })} ariaLabel="Margin floor" /></td><td /></tr>
                <RateRows label="Customer discount" rows={B.discount || []} disabled={disabled} onChange={(rows) => draft.update((d) => { d.discount = rows; })} />
              </tbody>
            </table></div>
            <div className="body note">Example: Ø137 at qty 2 with today's inputs — see the calculator's <b>why?</b> for the live substituted formula; a margin below the floor is flagged, never silently accepted. Rounding {B.rounding ? `${String(B.rounding.mode || 'HALF_UP').toLowerCase().replace('_', '-')}, ${B.rounding.decimalPlaces ?? 2} dp` : 'half-up, 2 dp'}.</div>
          </Panel>
        </>
      )}
    </>
  );
}
