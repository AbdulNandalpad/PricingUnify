import { useEffect, useState } from 'react';
import { describeMatch, specificityOf } from '../format.js';
import { Chip, Empty, ErrorBox, Loading, Panel } from '../components/ui.jsx';
import { useDraft } from './drafts.js';
import { DateInput, MatchInputs, NumInput, RateRows, TextInput, Tiers } from './editors.jsx';

export function BookPicker({ books, value, onChange, kind }) {
  if (books.length <= 1) return null;
  return (
    <div className="tabs sub" role="tablist">
      {books.map((b) => <button type="button" key={b.id} role="tab" aria-selected={b.id === value} className={b.id === value ? 'active' : ''} onClick={() => onChange(b.id)}>{b.name || b.id}{kind && b.draft ? <span className="chip warn">draft</span> : null}</button>)}
    </div>
  );
}

export default function PriceListsSheet({ asOf, registry, isAdmin }) {
  const books = registry.books['price-list'];
  const [id, setId] = useState(books[0]?.id || null);
  useEffect(() => { if (!id && books[0]) setId(books[0].id); }, [books, id]);
  const draft = useDraft({ kind: 'price-list', key: id, asOf, registry, isAdmin, enabled: Boolean(id) });
  const B = draft.working;
  const disabled = !isAdmin;
  if (!id) return registry.scanning ? <Loading what="Loading price lists" /> : <Empty>No price list exists yet. Books are created through the API or a seed; this screen edits existing ones.</Empty>;
  const dims = B?.dimensions || [];
  const setRow = (i, patch) => draft.update((d) => { d.rows[i] = { ...d.rows[i], ...patch }; });
  return (
    <>
      <BookPicker books={books.map((b) => ({ ...b, draft: registry.entries[`price-list|${b.id}`]?.draft }))} value={id} onChange={setId} kind />
      <ErrorBox error={draft.error} onRetry={draft.reload} />
      <ErrorBox error={draft.saveError} />
      {draft.loading && !B && <Loading what="Loading price list" />}
      {B && (
        <>
          <Panel
            title={<>{B.name} <Chip kind="pl">Price list</Chip>{draft.saving ? <span className="saving">saving draft…</span> : draft.hasDraft ? <Chip kind="warn">draft v{draft.draft.version}</Chip> : draft.live ? <Chip kind="good">live v{draft.live.version}</Chip> : null}</>}
            sub={`Applies when ${describeMatch(B.appliesWhen)} · ${B.currency} · net, ex VAT`}
            actions={!disabled && <button type="button" className="btn small" onClick={() => draft.update((d) => { d.rows.push({ part: '', match: {}, tiers: [{ from: 0, value: '0' }], validFrom: asOf }); })}>+ Add row</button>}
          >
            <div className="scroll"><table>
              <thead><tr><th>Part</th>{dims.map((d) => <th key={d.attr}>{d.label || d.attr} <span className="faint">w{d.weight}</span></th>)}<th className="num">Specificity</th><th>Price by quantity</th><th>Valid from / to</th><th></th></tr></thead>
              <tbody>{(B.rows || []).map((r, i) => (
                <tr key={i}>
                  <td><TextInput className="mono" value={r.part} disabled={disabled} width={130} list="parts" onChange={(v) => setRow(i, { part: v })} ariaLabel="Part" /></td>
                  <MatchInputs match={r.match} dimensions={dims} disabled={disabled} onChange={(m) => setRow(i, { match: m })} />
                  <td className="num"><Chip>{specificityOf(r.match, dims)}</Chip></td>
                  <td><Tiers tiers={r.tiers} disabled={disabled} onChange={(t) => setRow(i, { tiers: t })} /></td>
                  <td><div className="tiers"><DateInput value={r.validFrom} disabled={disabled} onChange={(v) => setRow(i, { validFrom: v })} ariaLabel="Valid from" /> <DateInput value={r.validTo} allowEmpty disabled={disabled} onChange={(v) => setRow(i, { validTo: v || undefined })} ariaLabel="Valid to" /></div></td>
                  <td>{!disabled && <button type="button" className="btn ghost small danger" onClick={() => draft.update((d) => { d.rows.splice(i, 1); })}>remove</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="body note">Leave a dimension blank to mean “any”. When several rows fit a line, the one with the highest specificity wins — a customer-specific row (100) beats a tier row (30) beats a default (0). Two rows with equal specificity are flagged as an error at go-live, never resolved by chance.</div>
          </Panel>
          <div className="grid g2">
            <Panel title="After the list price" mb={false} actions={!disabled && <button type="button" className="btn small" onClick={() => draft.update((d) => { d.discount = [...(d.discount || []), { match: {}, value: 0 }]; })}>+ Discount row</button>}>
              <div className="scroll"><table>
                <thead><tr><th>Step</th><th>Condition</th><th className="num">Rate</th><th></th></tr></thead>
                <tbody>
                  <RateRows label="Customer discount" rows={B.discount || []} disabled={disabled} dims={dims} onChange={(rows) => draft.update((d) => { d.discount = rows; })} />
                  {(B.constraints || []).map((c, i) => (
                    <tr key={c.id || i}><td>Minimum order line value</td><td>{c.mode === 'QUANTITY' ? 'raise the quantity' : 'raise the unit price'}</td><td className="num"><NumInput value={c.min} disabled={disabled} onChange={(v) => draft.update((d) => { d.constraints[i].min = v; })} ariaLabel="MOLV" /> <span className="small muted">{B.currency}</span></td><td /></tr>
                  ))}
                </tbody>
              </table></div>
            </Panel>
            <Panel title="Dimensions" sub="the columns a row can condition on" mb={false}>
              <div className="body">
                <dl className="kv dim-list">
                  {dims.map((d, i) => <div key={d.attr} style={{ display: 'contents' }}><dt>{d.label || d.attr}</dt><dd>weight <NumInput value={d.weight} step={1} width={64} disabled={disabled} onChange={(v) => draft.update((x) => { x.dimensions[i].weight = Number(v); })} ariaLabel={`${d.attr} weight`} /> <span className="small muted mono">{d.attr}</span></dd></div>)}
                </dl>
                <div className="note">Adding a dimension (e.g. sales org, product group) is one row here — no code, no migration.</div>
                {!disabled && <AddDimension onAdd={(dim) => draft.update((d) => { d.dimensions = [...(d.dimensions || []), dim]; })} />}
              </div>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

function AddDimension({ onAdd }) {
  const [attr, setAttr] = useState('');
  return (
    <span className="inline-form" style={{ marginTop: 8 }}>
      <input type="text" className="mono" placeholder="attribute, e.g. salesOrg" value={attr} onChange={(e) => setAttr(e.target.value)} aria-label="New dimension" style={{ width: 180 }} />
      <button type="button" className="btn small" disabled={!attr.trim()} onClick={() => { onAdd({ attr: attr.trim(), label: attr.trim(), weight: 10 }); setAttr(''); }}>+ Dimension</button>
    </span>
  );
}
