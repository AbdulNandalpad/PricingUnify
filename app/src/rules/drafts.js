import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api.js';
import { clone } from '../format.js';
import { REGIONS } from '../calculator/useQuote.js';

export const entryId = (kind, key) => `${kind}|${key}`;

const byVersionDesc = (a, b) => String(b.version).localeCompare(String(a.version));
export const latestDraft = (versions) => [...versions].filter((v) => v.status === 'DRAFT').sort(byVersionDesc)[0] || null;
export const activeVersion = (versions) => [...versions].filter((v) => v.status === 'ACTIVE').sort((a, b) => String(b.validFrom).localeCompare(String(a.validFrom)))[0] || null;

/** Every rules document the app knows about, with its open DRAFT (if any) and the diff
 *  against the ACTIVE version — the source of truth for the nav badge, the "Unsaved changes"
 *  banner count and the Go live screen. Server-truthful: it only ever reads listVersions/diff. */
export function useDraftRegistry({ ready, user }) {
  const [books, setBooks] = useState({ 'price-list': [], 'catalog-book': [] });
  const [entries, setEntries] = useState({});
  const [scanning, setScanning] = useState(false);
  const gen = useRef(0);

  const documents = useMemo(() => [
    ...REGIONS.map((r) => ({ kind: 'region-config', key: api.docKey('region-config', { region: r }), name: `${r} · cost plus` })),
    ...books['price-list'].map((b) => ({ kind: 'price-list', key: b.id, name: `${b.name || b.id} · price list` })),
    ...books['catalog-book'].map((b) => ({ kind: 'catalog-book', key: b.id, name: `${b.name || b.id} · catalog + formula` })),
    { kind: 'routing-rules', key: '*', name: 'Which type applies' },
  ], [books]);

  const refreshOne = useCallback(async (kind, key, name) => {
    const versions = api.asList(await api.listVersions(kind, key), 'versions');
    const draft = latestDraft(versions);
    const live = activeVersion(versions);
    let changes = null;
    if (draft && live) {
      try { const d = await api.diff(kind, key, live.version, draft.version); changes = api.asList(d, 'changes'); } catch { changes = null; }
    } else if (draft && !live) changes = [{ path: '/', from: undefined, to: '(new document)' }];
    const id = entryId(kind, key);
    let entry;
    setEntries((e) => { entry = { kind, key, name: name || e[id]?.name || `${kind} ${key}`, versions, draft, live, changes }; return { ...e, [id]: entry }; });
    return entry;
  }, []);

  const scanAll = useCallback(async () => {
    if (!ready) return;
    const my = ++gen.current;
    setScanning(true);
    try {
      const [pl, cb] = await Promise.all([
        api.listBooks('price-list').then((r) => api.asList(r, 'books')).catch(() => []),
        api.listBooks('catalog-book').then((r) => api.asList(r, 'books')).catch(() => []),
      ]);
      if (gen.current !== my) return;
      setBooks({ 'price-list': pl, 'catalog-book': cb });
      const docs = [
        ...REGIONS.map((r) => ({ kind: 'region-config', key: api.docKey('region-config', { region: r }), name: `${r} · cost plus` })),
        ...pl.map((b) => ({ kind: 'price-list', key: b.id, name: `${b.name || b.id} · price list` })),
        ...cb.map((b) => ({ kind: 'catalog-book', key: b.id, name: `${b.name || b.id} · catalog + formula` })),
        { kind: 'routing-rules', key: '*', name: 'Which type applies' },
      ];
      await Promise.all(docs.map((d) => refreshOne(d.kind, d.key, d.name).catch(() => null)));
    } finally { if (gen.current === my) setScanning(false); }
  }, [ready, refreshOne]);

  useEffect(() => { scanAll(); }, [scanAll, user]);

  const list = useMemo(() => Object.values(entries), [entries]);
  const drafts = useMemo(() => list.filter((e) => e.draft), [list]);
  const changeCount = useMemo(() => drafts.reduce((n, e) => n + (e.changes ? e.changes.length : 0), 0), [drafts]);
  const liveVersion = useMemo(() => {
    const versions = list.map((e) => e.live?.version).filter(Boolean).sort();
    return versions.at(-1) || null;
  }, [list]);

  return { documents, entries, list, drafts, draftCount: drafts.length, changeCount, liveVersion, refreshOne, scanAll, scanning, books };
}

/** One sheet's document: the LIVE version as of `asOf`, the open DRAFT, and a working copy.
 *  Every edit goes to `saveDraft` (debounced); edits land on the existing draft version. */
export function useDraft({ kind, key, asOf, registry, enabled = true, isAdmin }) {
  const [state, setState] = useState({ live: null, draft: null, working: null, loading: true, error: null, notFound: false });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const timer = useRef(null);
  const pending = useRef(null);
  const draftRef = useRef(null);

  const load = useCallback(async () => {
    if (!enabled || !kind || !key) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [live, versions] = await Promise.all([
        api.getEffective(kind, key, asOf).catch((e) => { if (e instanceof api.ApiError && e.status === 404) return null; throw e; }),
        api.listVersions(kind, key).then((r) => api.asList(r, 'versions')).catch((e) => { if (e instanceof api.ApiError && e.status === 404) return []; throw e; }),
      ]);
      const draft = latestDraft(versions);
      draftRef.current = draft;
      setState({ live, draft, working: clone(draft || live), loading: false, error: null, notFound: !live && !draft });
    } catch (error) { setState((s) => ({ ...s, loading: false, error })); }
  }, [kind, key, asOf, enabled]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const flush = useCallback(async () => {
    const doc = pending.current;
    if (!doc) return;
    pending.current = null;
    setSaving(true); setSaveError(null);
    const attempt = async (withVersion) => api.saveDraft(kind, { ...doc, ...(withVersion && draftRef.current ? { version: draftRef.current.version } : { version: undefined }) });
    try {
      let saved;
      try { saved = await attempt(true); } catch (e) {
        // A backend that treats versions as immutable answers "already exists" — fall back to a
        // fresh auto-versioned draft and retire the one it replaces.
        if (draftRef.current && e instanceof api.ApiError && e.status === 422 && /exist/i.test(e.message)) {
          const old = draftRef.current.version;
          saved = await attempt(false);
          api.discardDraft({ kind, key, version: old }).catch(() => {});
        } else throw e;
      }
      const savedDoc = saved?.doc && typeof saved.doc === 'object' ? saved.doc : saved;
      const draft = { ...doc, ...(savedDoc && savedDoc.version ? { version: savedDoc.version, status: 'DRAFT', validFrom: savedDoc.validFrom, provenance: savedDoc.provenance } : { status: 'DRAFT' }) };
      draftRef.current = draft;
      setState((s) => ({ ...s, draft, working: pending.current ? s.working : { ...s.working, version: draft.version, status: 'DRAFT' } }));
      registry?.refreshOne(kind, key).catch(() => {});
    } catch (e) { setSaveError(e); } finally { setSaving(false); }
  }, [kind, key, registry]);

  /** Apply `mutate(workingCopy)` and schedule a draft save. Viewers cannot edit. */
  const update = useCallback((mutate) => {
    if (!isAdmin) return;
    setState((s) => {
      if (!s.working) return s;
      const next = clone(s.working);
      mutate(next);
      pending.current = next;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 700);
      return { ...s, working: next };
    });
  }, [isAdmin, flush]);

  const discard = useCallback(async () => {
    clearTimeout(timer.current); pending.current = null;
    const d = draftRef.current;
    if (d) await api.discardDraft({ kind, key, version: d.version });
    draftRef.current = null;
    setState((s) => ({ ...s, draft: null, working: clone(s.live) }));
    registry?.refreshOne(kind, key).catch(() => {});
  }, [kind, key, registry]);

  return { ...state, saving, saveError, update, discard, reload: load, hasDraft: Boolean(state.draft) };
}
