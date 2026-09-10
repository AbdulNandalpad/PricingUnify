import { useEffect, useState } from 'react';
import * as api from '../api.js';
import { Chip, Empty, ErrorBox, Loading, Panel, TypeChip } from '../components/ui.jsx';
import { useDraft } from './drafts.js';
import { TextInput } from './editors.jsx';

/** Customer data origins whose region-route is shown — the seeded set (no listKeys endpoint). */
const OODS = ['SAP', 'SMA', 'CN', 'IN'];

export default function RoutingSheet({ asOf, registry, isAdmin }) {
  const draft = useDraft({ kind: 'routing-rules', key: '*', asOf, registry, isAdmin });
  const doc = draft.working;
  const disabled = !isAdmin;
  const books = { PRICE_LIST: registry.books['price-list'], CATALOG_FORMULA: registry.books['catalog-book'] };
  const [routes, setRoutes] = useState([]);
  useEffect(() => {
    let cancelled = false;
    Promise.all(OODS.map((ood) => api.getEffective('region-route', api.docKey('region-route', { ood }), asOf).then((r) => ({ ood, ...r })).catch(() => ({ ood, region: null }))))
      .then((rs) => { if (!cancelled) setRoutes(rs); });
    return () => { cancelled = true; };
  }, [asOf]);

  const rules = doc?.rules || [];
  const setRule = (i, patch) => draft.update((d) => { d.rules[i] = { ...d.rules[i], ...patch }; });
  const move = (i, dir) => draft.update((d) => { const j = i + dir; if (j < 0 || j >= d.rules.length) return; [d.rules[i], d.rules[j]] = [d.rules[j], d.rules[i]]; });
  return (
    <>
      <ErrorBox error={draft.error} onRetry={draft.reload} />
      <ErrorBox error={draft.saveError} />
      {draft.loading && !doc && <Loading what="Loading routing rules" />}
      {!draft.loading && !doc && <Empty>No routing rules exist yet — every line is cost plus until a rules document is created.</Empty>}
      {doc && (
        <Panel
          title={<>Which pricing type applies {draft.saving ? <span className="saving">saving draft…</span> : draft.hasDraft ? <Chip kind="warn">draft v{draft.draft.version}</Chip> : draft.live ? <Chip kind="good">live v{draft.live.version}</Chip> : null}</>}
          sub="Checked top to bottom per line; the first rule that fits decides. Anything left over is cost plus for the customer's region."
          actions={!disabled && <button type="button" className="btn small" onClick={() => draft.update((d) => { d.rules.push({ when: { family: '' }, type: 'PRICE_LIST', book: books.PRICE_LIST[0]?.id || '' }); })}>+ Add rule</button>}
        >
          <div className="scroll"><table>
            <thead><tr><th>#</th><th>When the part's</th><th>is</th><th>Price with</th><th>Book</th><th></th></tr></thead>
            <tbody>
              {rules.map((r, i) => {
                const [attr, val] = Object.entries(r.when || {})[0] || ['family', ''];
                return (
                  <tr key={i}>
                    <td className="mono muted">{i + 1}</td>
                    <td><TextInput className="mono" value={attr} width={110} disabled={disabled} ariaLabel="Attribute" onChange={(a) => setRule(i, { when: { [a || 'family']: val } })} /></td>
                    <td><TextInput value={val} disabled={disabled} ariaLabel="Value" onChange={(v) => setRule(i, { when: { [attr]: v } })} /></td>
                    <td><select value={r.type} disabled={disabled} aria-label="Pricing type" onChange={(e) => setRule(i, { type: e.target.value, book: books[e.target.value][0]?.id || '' })}><option value="PRICE_LIST">Price list</option><option value="CATALOG_FORMULA">Catalog + formula</option></select></td>
                    <td><select value={r.book} disabled={disabled} aria-label="Book" onChange={(e) => setRule(i, { book: e.target.value })}>{(books[r.type] || []).map((b) => <option key={b.id} value={b.id}>{b.name || b.id}</option>)}{r.book && !(books[r.type] || []).some((b) => b.id === r.book) && <option value={r.book}>{r.book}</option>}</select></td>
                    <td>{!disabled && <span className="row-actions"><button type="button" className="btn ghost small" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button><button type="button" className="btn ghost small" onClick={() => move(i, 1)} disabled={i === rules.length - 1} aria-label="Move down">↓</button><button type="button" className="btn ghost small danger" onClick={() => draft.update((d) => { d.rules.splice(i, 1); })}>remove</button></span>}</td>
                  </tr>
                );
              })}
              <tr><td className="mono muted">{rules.length + 1}</td><td className="muted" colSpan={2}>everything else</td><td><TypeChip technique="COST_PLUS" /></td><td className="muted">the region's landed-cost rules</td><td /></tr>
            </tbody>
          </table></div>
          <div className="body note">A rep can still override the type on a line — that shows as “manual” in the trace. Each book also has its own “applies when” scope (region, family) that must fit, so a European price list never prices a China line by accident.</div>
        </Panel>
      )}
      <Panel title="Customer → region" sub="from the customer's data origin + sales org">
        <div className="scroll"><table>
          <thead><tr><th>Data origin</th><th>Region</th><th>Legal entity</th></tr></thead>
          <tbody>{routes.map((r) => <tr key={r.ood}><td className="mono">{r.ood}</td><td>{r.region || <span className="faint">no route</span>}</td><td>{r.entityLabel || '—'}</td></tr>)}</tbody>
        </table></div>
        <div className="body note">Read-only here: region routes and customers come from the host system's master data.</div>
      </Panel>
    </>
  );
}
