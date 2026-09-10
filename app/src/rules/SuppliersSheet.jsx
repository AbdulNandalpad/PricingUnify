import { Fragment, useEffect, useState } from 'react';
import * as api from '../api.js';
import { clone, todayIso } from '../format.js';
import { Chip, ErrorBox, Loading, Panel } from '../components/ui.jsx';
import { NumInput, PctInput, TextInput } from './editors.jsx';

const RATES = ['freight', 'duty', 'tariff'];

/** Suppliers are saved directly as a new ACTIVE version (`saveActive`), as before — so edits
 *  stay local until the row's Save is pressed instead of auto-saving a draft. */
export default function SuppliersSheet({ asOf, isAdmin, toast }) {
  const [live, setLive] = useState([]);
  const [work, setWork] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(null);
  const [newWh, setNewWh] = useState({});
  const [newSup, setNewSup] = useState('');
  const disabled = !isAdmin;

  const load = async () => {
    setLoading(true); setError(null);
    try { const list = api.asList(await api.listSuppliers(asOf), 'suppliers'); setLive(list); setWork(clone(list)); } catch (e) { setError(e); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [asOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = (s) => JSON.stringify(s) !== JSON.stringify(live.find((l) => l.supplier === s.supplier) || null);
  const set = (id, mutate) => setWork((w) => w.map((s) => { if (s.supplier !== id) return s; const n = clone(s); mutate(n); return n; }));
  const save = async (s) => {
    setSaving(s.supplier); setError(null);
    try {
      const { version, status, validTo, supersedes, provenance, ...body } = s; // eslint-disable-line no-unused-vars
      await api.saveActive({ kind: 'supplier-config', doc: { ...body, validFrom: todayIso() }, effectiveFrom: todayIso(), note: `Supplier ${s.supplier} terms updated in the app` });
      toast(`${s.supplier} saved as a new live version`);
      await load();
    } catch (e) { setError(e); } finally { setSaving(null); }
  };
  const addSupplier = () => {
    const id = newSup.trim().toUpperCase();
    if (!id || work.some((s) => s.supplier === id)) return;
    setWork((w) => [...w, { supplier: id, supplierCountry: '', molv: null, warehouses: {} }]);
    setNewSup('');
  };

  return (
    <Panel
      title="Suppliers"
      sub="Independent of region: a supplier ships to warehouses everywhere. Freight, duty and tariff are % on (base cost + markup) per destination warehouse; MOLV is supplier-wide. Saving publishes a new live version at once."
      actions={!disabled && <span className="inline-form"><input type="text" className="mono" placeholder="NEW-SUPPLIER" value={newSup} onChange={(e) => setNewSup(e.target.value)} aria-label="New supplier id" style={{ width: 150 }} onKeyDown={(e) => { if (e.key === 'Enter') addSupplier(); }} /><button type="button" className="btn small" disabled={!newSup.trim()} onClick={addSupplier}>+ Supplier</button></span>}
    >
      <ErrorBox error={error} onRetry={load} />
      {loading && <div className="body"><Loading what="Loading suppliers" /></div>}
      <div className="scroll"><table>
        <thead><tr><th>Supplier</th><th>Country</th><th className="num">MOLV</th><th>Warehouse</th><th className="num">Freight %</th><th className="num">Duty %</th><th className="num">Tariff %</th><th></th></tr></thead>
        <tbody>
          {work.map((s) => {
            const whs = Object.entries(s.warehouses || {});
            const span = Math.max(whs.length, 1) + (disabled ? 0 : 1);
            const head = (
              <>
                <td rowSpan={span} className="mono"><b>{s.supplier}</b>{dirty(s) && <div><Chip kind="warn">unsaved</Chip></div>}{s.version && <div className="small muted">v{s.version}</div>}</td>
                <td rowSpan={span}><TextInput value={s.supplierCountry ?? ''} width={60} disabled={disabled} ariaLabel="Country" onChange={(v) => set(s.supplier, (n) => { n.supplierCountry = v || null; })} /></td>
                <td rowSpan={span} className="num"><NumInput value={s.molv} step={1} disabled={disabled} placeholder="—" ariaLabel="MOLV" onChange={(v) => set(s.supplier, (n) => { n.molv = v; })} /></td>
              </>
            );
            const actions = (
              <td rowSpan={span}>{!disabled && <button type="button" className="btn primary small" disabled={!dirty(s) || saving === s.supplier} onClick={() => save(s)}>{saving === s.supplier ? 'Saving…' : 'Save'}</button>}</td>
            );
            const rows = whs.length ? whs.map(([w, t], i) => (
              <tr key={`${s.supplier}-${w}`}>
                {i === 0 && head}
                <td className="mono">{w}{!disabled && <button type="button" className="btn ghost small danger" onClick={() => set(s.supplier, (n) => { delete n.warehouses[w]; })} aria-label={`Remove ${w}`}>×</button>}</td>
                {RATES.map((f) => <td key={f} className="num"><PctInput value={t[f] ?? 0} disabled={disabled} ariaLabel={`${w} ${f}`} onChange={(v) => set(s.supplier, (n) => { n.warehouses[w][f] = v; })} /></td>)}
                {i === 0 && actions}
              </tr>
            )) : (
              <tr key={`${s.supplier}-none`}>{head}<td colSpan={4} className="muted small">no warehouse terms — part data is used</td>{actions}</tr>
            );
            return (
              <Fragment key={s.supplier}>
                {rows}
                {!disabled && (
                  <tr className="sub"><td colSpan={5}>
                    <span className="inline-form"><input type="text" className="mono" placeholder="warehouse, e.g. US01" value={newWh[s.supplier] || ''} onChange={(e) => setNewWh((m) => ({ ...m, [s.supplier]: e.target.value }))} aria-label={`New warehouse for ${s.supplier}`} style={{ width: 160 }} />
                      <button type="button" className="btn small" disabled={!(newWh[s.supplier] || '').trim()} onClick={() => { const w = newWh[s.supplier].trim().toUpperCase(); set(s.supplier, (n) => { n.warehouses = { ...(n.warehouses || {}), [w]: { freight: 0, duty: 0, tariff: 0 } }; }); setNewWh((m) => ({ ...m, [s.supplier]: '' })); }}>+ warehouse</button></span>
                  </td></tr>
                )}
              </Fragment>
            );
          })}
          {!loading && work.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 26 }}>No suppliers configured.</td></tr>}
        </tbody>
      </table></div>
    </Panel>
  );
}
