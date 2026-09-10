import { useEffect, useMemo, useState } from 'react';
import * as api from '../api.js';
import { fmt2, fmtDiffValue, humanPath, lineTotal, num } from '../format.js';
import { Callout, Chip, Empty, ErrorBox, Field, Loading, Panel, TypeChip } from '../components/ui.jsx';
import { useAsync } from '../hooks.js';

/** `POST simulate` with the calculator's current lines and the open draft(s). */
function WhatWouldChange({ quote, registry }) {
  const drafts = registry.drafts;
  const refs = useMemo(() => drafts.map((e) => ({ kind: e.kind, key: e.key, version: e.draft.version })), [drafts]);
  const items = quote.items;
  const { data, error, loading, reload } = useAsync(
    () => api.simulate({ ...quote.context, items, draft: refs[0], drafts: refs }),
    [JSON.stringify(refs), JSON.stringify(items), quote.context.customerId, quote.context.region, quote.context.priceDate],
    { enabled: refs.length > 0 && items.length > 0 },
  );
  if (refs.length === 0) return null;
  const lines = api.asList(data, 'items').length ? api.asList(data, 'items') : api.asList(data, 'lines');
  const totals = data?.totals;
  const delta = num(totals?.delta);
  const cur = totals?.currency || lines.find((l) => l.live?.result || l.draft?.result)?.live?.result?.currency || '';
  return (
    <Panel title="What would change" sub="Your open quote repriced with the draft — before anyone else sees it." actions={<>{delta !== null && <Chip kind={delta > 0.005 ? 'warn' : delta < -0.005 ? 'good' : 'neutral'}>{delta >= 0 ? '+' : ''}{fmt2(delta)} {cur} on the quote total</Chip>}<button type="button" className="btn small" onClick={reload} disabled={loading}>{loading ? 'Simulating…' : 'Re-run'}</button></>}>
      <ErrorBox error={error} onRetry={reload} />
      {items.length === 0 && <div className="body muted">Add lines in the calculator to see the effect of the draft.</div>}
      {loading && !data && <div className="body"><Loading what="Simulating" /></div>}
      {lines.length > 0 && (
        <div className="scroll"><table>
          <thead><tr><th>Part</th><th>Type</th><th className="num">Live</th><th className="num">Draft</th><th className="num">Δ line total</th><th></th></tr></thead>
          <tbody>{lines.map((l, i) => {
            const before = l.live || l.before; const after = l.draft || l.after;
            const bp = l.lineTotalLive != null ? num(l.lineTotalLive) : lineTotal(before);
            const ap = l.lineTotalDraft != null ? num(l.lineTotalDraft) : lineTotal(after);
            const d = l.delta != null ? num(l.delta) : bp !== null && ap !== null ? ap - bp : null;
            const crit = after?.status === 'PRICED' && (after.flags || []).some((f) => f.level === 'crit');
            return (
              <tr key={i}>
                <td className="mono">{l.partNumber || after?.partNumber}</td>
                <td><TypeChip technique={after?.technique || before?.technique} /></td>
                <td className="num mono">{bp === null ? '—' : fmt2(bp)}</td>
                <td className="num mono">{ap === null ? '—' : fmt2(ap)}</td>
                <td className={`num mono delta ${d === null ? 'same' : d > 0.005 ? 'up' : d < -0.005 ? 'down' : 'same'}`}>{d === null ? (after?.status !== before?.status ? after?.status : '—') : `${d > 0 ? '+' : ''}${fmt2(d)}`}</td>
                <td>{crit ? <Chip kind="crit">floor</Chip> : after?.status === 'MISSING' ? <Chip kind="crit">missing</Chip> : after?.status === 'BLOCKED' ? <Chip kind="crit">blocked</Chip> : null}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {(api.asList(data, 'floorCrossings').length > 0 || api.asList(data, 'deadRows').length > 0) && (
        <div className="body small muted">{api.asList(data, 'floorCrossings').length ? `Floor crossings: ${api.asList(data, 'floorCrossings').map((x) => (typeof x === 'string' ? x : x.partNumber || JSON.stringify(x))).join(', ')}. ` : ''}{api.asList(data, 'deadRows').length ? `Rows nothing would hit: ${api.asList(data, 'deadRows').length}.` : ''}</div>
      )}
    </Panel>
  );
}

function Changes({ registry, isAdmin, onPublished, toast, priceDate }) {
  const [note, setNote] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(priceDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setEffectiveFrom(priceDate); }, [priceDate]);
  const drafts = registry.drafts;
  if (drafts.length === 0) return <Empty>No unsaved changes. Edit any table under <b>Pricing rules</b> and it appears here as a draft.</Empty>;
  const publishAll = async () => {
    setBusy(true); setError(null);
    try {
      for (const e of drafts) await api.publish({ kind: e.kind, key: e.key, version: e.draft.version, effectiveFrom, note });
      toast(`${drafts.length === 1 ? drafts[0].draft.version : `${drafts.length} drafts`} now live from ${effectiveFrom} — ${registry.changeCount} change${registry.changeCount === 1 ? '' : 's'} price every new line`);
      setNote('');
      await registry.scanAll();
      onPublished?.();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const discardAll = async () => {
    if (!window.confirm('Discard every open draft?')) return;
    setBusy(true); setError(null);
    try { for (const e of drafts) await api.discardDraft({ kind: e.kind, key: e.key, version: e.draft.version }); await registry.scanAll(); toast('Drafts discarded'); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Panel title="Changes in this draft" actions={<Chip kind="warn">{registry.changeCount}</Chip>}>
      <ErrorBox error={error} />
      <div className="scroll"><table>
        <thead><tr><th>Document</th><th>What</th><th>Live</th><th>Draft</th></tr></thead>
        <tbody>
          {drafts.flatMap((e) => (e.changes && e.changes.length ? e.changes : [{ path: '/', from: undefined, to: '(no differences reported)' }]).map((d, i) => (
            <tr key={`${e.kind}|${e.key}|${i}`}>
              <td className="small">{e.name}<div className="mono faint">{e.live ? `v${e.live.version}` : 'new'} → draft {e.draft.version}</div></td>
              <td>{humanPath(d.path, e.draft)}</td>
              <td className="diff"><span className="rem">{fmtDiffValue(d.from)}</span></td>
              <td className="diff"><span className="add">{fmtDiffValue(d.to)}</span></td>
            </tr>
          )))}
        </tbody>
      </table></div>
      <div className="body inline-form">
        <Field label="Note for the history" className="grow"><input type="text" placeholder="e.g. Q4 freight increase from ACME" value={note} onChange={(e) => setNote(e.target.value)} disabled={!isAdmin} /></Field>
        <Field label="Effective from"><input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} disabled={!isAdmin} /></Field>
        <button type="button" className="btn" onClick={discardAll} disabled={!isAdmin || busy}>Discard</button>
        <button type="button" className="btn primary" onClick={publishAll} disabled={!isAdmin || busy}>{busy ? 'Publishing…' : 'Go live'}</button>
      </div>
      <div className="body small muted tight">Go live publishes {drafts.length === 1 ? `draft ${drafts[0].draft.version} of ${drafts[0].name}` : `${drafts.length} drafts`} and supersedes the live version{drafts.length === 1 ? '' : 's'} from the effective date. Nothing is edited in place — any past quote reprices exactly as it did.{!isAdmin && ' Publishing needs the PricingAdmin role.'}</div>
    </Panel>
  );
}

function History({ registry, priceDate, setPriceDate, region }) {
  const docs = registry.documents;
  const defaultDoc = docs.find((d) => d.kind === 'region-config' && d.key.startsWith(region)) || docs[0];
  const [sel, setSel] = useState(defaultDoc ? `${defaultDoc.kind}|${defaultDoc.key}` : '');
  useEffect(() => { if (!sel && defaultDoc) setSel(`${defaultDoc.kind}|${defaultDoc.key}`); }, [defaultDoc, sel]);
  const [kind, key] = sel.split('|');
  const { data, error, loading } = useAsync(() => api.listVersions(kind, key), [kind, key, registry.list.length], { enabled: Boolean(kind && key) });
  const versions = useMemo(() => api.asList(data, 'versions').slice().sort((a, b) => String(b.validFrom || '').localeCompare(String(a.validFrom || '')) || String(b.version).localeCompare(String(a.version))), [data]);
  const [compare, setCompare] = useState(null);
  const cmp = useAsync(() => api.diff(kind, key, compare.a, compare.b), [compare?.a, compare?.b, kind, key], { enabled: Boolean(compare) });
  const status = (v) => (v.status === 'ACTIVE' ? 'good' : v.status === 'DRAFT' ? 'warn' : v.status === 'REJECTED' ? 'crit' : 'neutral');
  return (
    <Panel title="Version history" actions={<>
      <select value={sel} onChange={(e) => { setSel(e.target.value); setCompare(null); }} aria-label="Document">{docs.map((d) => <option key={`${d.kind}|${d.key}`} value={`${d.kind}|${d.key}`}>{d.name}</option>)}</select>
      <Field label="Price as of" inline><input type="date" value={priceDate} onChange={(e) => setPriceDate(e.target.value)} /></Field>
    </>}>
      <div className="body">
        <ErrorBox error={error} />
        {loading && !data && <Loading what="Loading versions" />}
        {versions.map((v, i) => {
          const prev = versions.slice(i + 1).find((x) => x.status !== 'DRAFT' && x.status !== 'REJECTED');
          const p = v.provenance || {};
          return (
            <div className="vers" key={v.version}>
              <div><div className="mono"><b>v{v.version}</b></div><Chip kind={status(v)}>{String(v.status).toLowerCase()}</Chip></div>
              <div>
                <div className="small muted">{v.status === 'DRAFT' ? 'not yet effective' : `effective ${v.validFrom}${v.validTo ? ` → ${v.validTo}` : ''}`}{p.publishedBy ? ` · published by ${p.publishedBy}` : p.authoredBy ? ` · by ${p.authoredBy}` : ''}{p.source && p.source !== 'HUMAN' ? ` · ${String(p.source).toLowerCase()}` : ''}</div>
                {p.note && <ul><li>{p.note}</li></ul>}
                {compare && compare.b === v.version && (
                  <div style={{ marginTop: 8 }}>
                    <ErrorBox error={cmp.error} />
                    {cmp.loading ? <Loading what="Comparing" /> : (
                      <div className="scroll"><table>
                        <thead><tr><th>What</th><th>v{compare.a}</th><th>v{compare.b}</th></tr></thead>
                        <tbody>{api.asList(cmp.data, 'changes').map((d, j) => <tr key={j}><td>{humanPath(d.path, v)}</td><td className="diff"><span className="rem">{fmtDiffValue(d.from)}</span></td><td className="diff"><span className="add">{fmtDiffValue(d.to)}</span></td></tr>)}{api.asList(cmp.data, 'changes').length === 0 && !cmp.loading && <tr><td colSpan={3} className="muted">No differences.</td></tr>}</tbody>
                      </table></div>
                    )}
                  </div>
                )}
              </div>
              <div>{prev && <button type="button" className="btn small" onClick={() => setCompare(compare?.b === v.version ? null : { a: prev.version, b: v.version })}>{compare?.b === v.version ? 'Hide' : `Compare with v${prev.version}`}</button>}</div>
            </div>
          );
        })}
        {!loading && versions.length === 0 && <div className="muted">No versions.</div>}
        <div className="note">Effective dating is real: set the price date to before a version's effective date and the calculator prices with the version that was live then.</div>
      </div>
    </Panel>
  );
}

function PlainLanguage({ registry, isAdmin, toast }) {
  const docs = registry.documents;
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notConfigured, setNotConfigured] = useState(null);
  useEffect(() => { if (!target && docs[0]) setTarget(`${docs[0].kind}|${docs[0].key}`); }, [docs, target]);
  const pending = useAsync(() => api.listSuggestions('PENDING_REVIEW'), [registry.list.length], { enabled: isAdmin });
  const list = api.asList(pending.data, 'suggestions');
  const propose = async () => {
    const [kind, key] = target.split('|');
    if (!text.trim() || !kind) return;
    setBusy(true); setError(null); setNotConfigured(null);
    try {
      const res = await api.suggestChange({ targetKind: kind, targetKey: key, instruction: text.trim() });
      if (res?.status === 'AI_NOT_CONFIGURED') { setNotConfigured(res.message || 'The server has no AI credential configured.'); return; }
      setText('');
      toast('Suggestion recorded — review it below');
      pending.reload();
    } catch (e) {
      if (e instanceof api.ApiError && (e.code === 'AI_NOT_CONFIGURED' || /AI_NOT_CONFIGURED/.test(e.message))) setNotConfigured(e.message); else setError(e);
    } finally { setBusy(false); }
  };
  const review = async (s, ok) => {
    setBusy(true); setError(null);
    try {
      if (ok) await api.approveSuggestion({ suggestionId: s.id || s.suggestionId }); else await api.rejectSuggestion({ suggestionId: s.id || s.suggestionId, reviewNotes: 'Rejected in the app' });
      toast(ok ? 'Added to the draft — review under “Changes in this draft”' : 'Suggestion rejected');
      await registry.scanAll();
      pending.reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Panel title="Ask for a rule change in plain language" sub="Turns a sentence into a draft change you review — it never edits rules on its own." mb={false}>
      <div className="body">
        {!isAdmin && <Callout level="info" className="mb">Proposing and reviewing rule changes needs the PricingAdmin role.</Callout>}
        <div className="ai-row">
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target document" disabled={!isAdmin}>{docs.map((d) => <option key={`${d.kind}|${d.key}`} value={`${d.kind}|${d.key}`}>{d.name}</option>)}</select>
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} disabled={!isAdmin || busy} placeholder="e.g. Set SCM_MARKUP to 5%   ·   Set default margin to 28%" aria-label="Instruction" onKeyDown={(e) => { if (e.key === 'Enter') propose(); }} />
          <button type="button" className="btn" onClick={propose} disabled={!isAdmin || busy || !text.trim()}>Propose</button>
        </div>
        <ErrorBox error={error} />
        {notConfigured && <Callout level="info" className="sug"><b>AI is not configured on this server.</b> {notConfigured} Rules can still be edited directly under Pricing rules; the plain-language path switches on once an API key is set on the backend.</Callout>}
        <ErrorBox error={pending.error} />
        {list.map((s) => (
          <div className="callout info sug" key={s.id || s.suggestionId}>
            <div><b>“{s.instruction}”</b> <span className="small muted">→ {docs.find((d) => d.kind === s.targetKind && d.key === s.targetKey)?.name || `${s.targetKind} ${s.targetKey}`}{s.baseVersion ? ` · from v${s.baseVersion}` : ''}</span></div>
            {s.summary && <div className="small" style={{ marginTop: 4 }}>{s.summary}</div>}
            {Array.isArray(s.changes) && s.changes.length > 0 && <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{s.changes.slice(0, 6).map((d, i) => <li key={i}>{humanPath(d.path, s.proposed)}: <span className="diff"><span className="rem">{fmtDiffValue(d.from)}</span> → <span className="add">{fmtDiffValue(d.to)}</span></span></li>)}</ul>}
            <div className="small muted" style={{ marginTop: 4 }}>{[s.requestedBy ? `asked by ${s.requestedBy}` : null, s.model ? `model ${s.model}` : null, s.createdAt ? new Date(s.createdAt).toLocaleString() : null].filter(Boolean).join(' · ')}</div>
            <div className="acts"><button type="button" className="btn primary small" disabled={busy} onClick={() => review(s, true)}>Approve → draft</button><button type="button" className="btn small" disabled={busy} onClick={() => review(s, false)}>Reject</button></div>
          </div>
        ))}
        {isAdmin && !pending.loading && list.length === 0 && <div className="note">No suggestions waiting for review. Approving one creates a draft — someone still has to go live.</div>}
      </div>
    </Panel>
  );
}

export default function GoLive({ quote, registry, isAdmin, toast }) {
  return (
    <>
      <div className="page-head"><div><h1>Go live &amp; history</h1><p>Review what changed, see what it would do to real prices, then publish a new version.</p></div></div>
      <WhatWouldChange quote={quote} registry={registry} />
      <Changes registry={registry} isAdmin={isAdmin} toast={toast} priceDate={quote.priceDate} onPublished={() => quote.clearResults()} />
      <History registry={registry} priceDate={quote.priceDate} setPriceDate={quote.setPriceDate} region={quote.region} />
      <PlainLanguage registry={registry} isAdmin={isAdmin} toast={toast} />
    </>
  );
}
