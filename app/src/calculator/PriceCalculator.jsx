import { Fragment, useMemo, useState } from 'react';
import { BULK_COLUMNS, parseBulkText } from '../batch.js';
import { TYPES, fmt2, lineTotal, num, pct, statusChip } from '../format.js';
import { Chip, ErrorBox, Field } from '../components/ui.jsx';

const TYPE_OPTIONS = Object.entries(TYPES);

function typeCode(technique) { return TYPES[technique]?.code || 'cp'; }

/** Summary tiles — display-only arithmetic on server strings (unit price × quantity). */
function Summary({ quote }) {
  const lines = quote.rows.map((r) => quote.lineFor(r)).filter(Boolean);
  const priced = lines.filter((l) => l.status === 'PRICED');
  const totals = {};
  let costTot = 0; let sellOnCost = 0;
  for (const l of priced) {
    const t = lineTotal(l);
    totals[l.result.currency] = (totals[l.result.currency] || 0) + t;
    const lc = num(l.result.landedCost);
    if (lc !== null) { costTot += lc * num(l.result.quantity); sellOnCost += t; }
  }
  const blended = sellOnCost ? (sellOnCost - costTot) / sellOnCost : null;
  const attention = lines.filter((l) => l.status !== 'PRICED' || (l.flags || []).some((f) => f.level !== 'info')).length;
  const cfg = quote.results?.config;
  const version = cfg?.region || cfg?.version || quote.regionConfig?.version;
  return (
    <div className="summary">
      <div className="stat"><div className="label">Lines priced</div><div className="v">{priced.length} / {quote.rows.filter((r) => r.partNumber.trim()).length}</div><div className="s">{lines.length === 0 ? 'not priced yet' : attention ? `${attention} need attention` : 'nothing to check'}</div></div>
      {Object.entries(totals).map(([c, v]) => <div className="stat" key={c}><div className="label">Quote total</div><div className="v">{fmt2(v)} {c}</div><div className="s">net, ex VAT</div></div>)}
      {Object.keys(totals).length === 0 && <div className="stat"><div className="label">Quote total</div><div className="v">—</div><div className="s">price the lines to see it</div></div>}
      <div className="stat"><div className="label">Blended margin</div><div className="v">{blended == null ? '—' : pct(blended)}</div><div className="s">on cost-based lines</div></div>
      <div className="stat"><div className="label">Rules version</div><div className="v">{version ? `v${version}` : '—'}</div><div className="s">{[quote.regionConfig?.validFrom ? `effective ${quote.regionConfig.validFrom}` : null, quote.results?.entityLabel || quote.route?.entityLabel].filter(Boolean).join(' · ') || 'as of the price date'}</div></div>
    </div>
  );
}

function BulkAdd({ onAdd }) {
  const [text, setText] = useState('');
  const add = () => { const rows = parseBulkText(text); if (rows.length) { onAdd(rows); setText(''); } };
  const upload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { const rows = parseBulkText(String(reader.result)); if (rows.length) onAdd(rows); };
    reader.readAsText(file);
    e.target.value = '';
  };
  return (
    <div className="bulk-add">
      <div className="small muted">One line per part — <span className="mono">{BULK_COLUMNS}</span>; everything after the part is optional. A header row is skipped.</div>
      <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={'P-10023, 10\nP-70200, 30, ACME, EU01\nOR-25X3-NBR, 500'} aria-label="Paste lines" style={{ marginTop: 8 }} />
      <div className="actions">
        <button type="button" className="btn small" onClick={add} disabled={!text.trim()}>Add these lines</button>
        <label className="file-upload btn small">Upload .csv<input type="file" accept=".csv,.txt" onChange={upload} hidden /></label>
      </div>
    </div>
  );
}

export default function PriceCalculator({ quote, onWhy, selectedRowId }) {
  const [showMore, setShowMore] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const { rows, suppliers, regionConfig } = quote;
  const additionalCostMap = regionConfig?.additionalCostMap || null;
  const warehouses = useMemo(() => [...new Set(suppliers.flatMap((s) => Object.keys(s.warehouses || {})))].sort(), [suppliers]);
  const customerLabel = (id) => { const c = quote.customers[id]; return c ? `${c.name ? `${c.name} · ` : ''}${id}${c.tier ? ` · tier ${c.tier}` : ''}` : id; };
  const colCount = 13 + (showMore ? 3 : 0);

  return (
    <>
      <div className="page-head">
        <div><h1>Price calculator</h1><p>Add the parts, the engine picks the pricing type per line from your rules, prices it, and explains every number.</p></div>
        <div className="actions">
          <button type="button" className="btn" onClick={quote.addRow}>+ Add line</button>
          <button type="button" className="btn" onClick={() => setShowBulk((s) => !s)}>{showBulk ? 'Hide paste' : 'Paste / upload'}</button>
          <button type="button" className="btn" onClick={() => setShowMore((s) => !s)}>{showMore ? 'Fewer columns' : 'More columns'}</button>
          <button type="button" className="btn" onClick={quote.fetchAttributes} disabled={quote.fetching}>{quote.fetching ? 'Fetching…' : 'Fetch item attributes'}</button>
          <button type="button" className="btn primary" onClick={() => quote.priceAll()} disabled={quote.pricing}>{quote.pricing ? 'Pricing…' : 'Price all lines'}</button>
        </div>
      </div>

      <div className="controls">
        <Field label="Customer">
          <select value={quote.customerId} onChange={(e) => quote.selectCustomer(e.target.value)}>
            {Object.keys(quote.customers).length === 0 && <option value={quote.customerId}>{quote.customerId}</option>}
            {Object.keys(quote.customers).map((id) => <option key={id} value={id}>{customerLabel(id)}</option>)}
          </select>
        </Field>
        <Field label="Region" hint={quote.party?.customerOod ? `(from customer's data origin ${quote.party.customerOod})` : ''}>
          <select value={quote.region} onChange={(e) => quote.selectRegion(e.target.value)}>
            {quote.regions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        <Field label="Price date"><input type="date" value={quote.priceDate} onChange={(e) => quote.setPriceDate(e.target.value)} /></Field>
        <Field label="Quote"><span className="mono" style={{ padding: '6px 0' }}>{quote.quoteId}{quote.party?.territory ? ` · ${quote.party.territory}` : ''}{quote.results?.documentId ? <span className="muted small"> · last priced as {quote.results.documentId}</span> : null}</span></Field>
      </div>

      <ErrorBox error={quote.error} />
      {quote.note && <div className="callout good mb">{quote.note}</div>}

      <Summary quote={quote} />

      <div className={`panel line-grid ${showMore ? 'more' : ''}`}>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Part</th><th>Qty</th><th>Pricing type</th><th>Supplier</th><th>Warehouse</th><th>Stock class</th>
                {showMore && <><th>Additional cost</th><th>Data origin</th><th>Qty override</th></>}
                <th>Status</th><th className="num">Unit cost</th><th className="num">Unit price</th><th className="num">Margin</th><th className="num">Line total</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const line = quote.lineFor(row);
                const stale = quote.isStale(row);
                const technique = row.pricingType || line?.technique || 'COST_PLUS';
                const isCostPlus = technique === 'COST_PLUS';
                const chip = statusChip(line);
                const total = lineTotal(line);
                const knownSupplier = suppliers.some((s) => s.supplier === row.supplier);
                return (
                  <Fragment key={row.id}>
                    <tr className={selectedRowId === row.id ? 'sel' : ''}>
                      <td className="part-cell">
                        <input type="text" className="mono" list="parts" value={row.partNumber} onChange={(e) => quote.updateRow(row.id, { partNumber: e.target.value, pricingType: '', description: '' })} placeholder="P-10023" aria-label="Part number" />
                        <div className="part-desc">{row.description || quote.knownParts[row.partNumber] || (line?.status === 'MISSING' && line.missing?.reason === 'UNKNOWN_PART' ? 'unknown part' : '')}</div>
                      </td>
                      <td>
                        <input type="number" className="n" min="1" value={row.quantity} onChange={(e) => quote.updateRow(row.id, { quantity: e.target.value })} aria-label="Quantity" />
                        {line?.status === 'PRICED' && String(line.result.quantity) !== String(row.quantity) && <div className="sub-note warn">→ {line.result.quantity}</div>}
                      </td>
                      <td>
                        <div className="type-cell">
                          <select className={`type-select ${typeCode(technique)}`} value={row.pricingType} onChange={(e) => quote.updateRow(row.id, { pricingType: e.target.value })} title={line ? `Routed by ${line.routedBy}` : 'Let the rules decide, or force a type'} aria-label="Pricing type">
                            <option value="">{line && !row.pricingType ? `${TYPES[line.technique]?.label || 'Auto'}` : 'Auto (rules decide)'}</option>
                            {TYPE_OPTIONS.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                          </select>
                          {row.pricingType ? <Chip title="Overridden by you">manual</Chip> : line?.routedBy?.startsWith('RULE') ? <span className="small faint">rule {line.routedBy.split(':')[1]}</span> : null}
                        </div>
                      </td>
                      <td>
                        <select value={row.supplier} onChange={(e) => quote.updateRow(row.id, { supplier: e.target.value })} disabled={!isCostPlus} title={isCostPlus ? '' : 'Supplier terms only affect cost plus lines'} aria-label="Supplier">
                          <option value="">— none —</option>
                          {suppliers.map((s) => <option key={s.supplier} value={s.supplier}>{s.supplier}{s.supplierCountry ? ` (${s.supplierCountry})` : ''}</option>)}
                          {row.supplier && !knownSupplier && <option value={row.supplier}>{row.supplier}</option>}
                        </select>
                      </td>
                      <td>
                        <select value={row.warehouse} onChange={(e) => quote.updateRow(row.id, { warehouse: e.target.value })} disabled={!isCostPlus} aria-label="Warehouse">
                          <option value="">—</option>
                          {warehouses.map((w) => <option key={w} value={w}>{w}</option>)}
                          {row.warehouse && !warehouses.includes(row.warehouse) && <option value={row.warehouse}>{row.warehouse}</option>}
                        </select>
                      </td>
                      <td>
                        <select value={row.stockClass} onChange={(e) => quote.updateRow(row.id, { stockClass: e.target.value })} disabled={!isCostPlus} aria-label="Stock class">
                          <option value="">auto</option><option value="MTS">MTS</option><option value="NonMTS">NonMTS</option>
                        </select>
                        {(line?.trace?.stockClass || (!line && row.resolvedStockClass)) && <div className="sub-note">→ {line?.trace?.stockClass || row.resolvedStockClass}</div>}
                      </td>
                      {showMore && (
                        <>
                          <td>
                            <select value={row.additionalCost} onChange={(e) => quote.updateRow(row.id, { additionalCost: e.target.value })} disabled={!isCostPlus || !additionalCostMap} aria-label="Additional cost">
                              <option value="">default</option>
                              {Object.entries(additionalCostMap || {}).map(([k, v]) => <option key={k} value={k}>{k} – {v.label}</option>)}
                            </select>
                          </td>
                          <td><input type="text" className="mono" style={{ width: 70 }} value={row.ood} onChange={(e) => quote.updateRow(row.id, { ood: e.target.value })} placeholder="e.g. SAP" aria-label="Data origin" /></td>
                          <td><input type="number" className="n" min="0" value={row.mroqOverride} onChange={(e) => quote.updateRow(row.id, { mroqOverride: e.target.value })} placeholder="qty" aria-label="Quantity override" /></td>
                        </>
                      )}
                      <td>{stale && line ? <Chip title="The line changed since it was priced">re-price</Chip> : chip ? <Chip kind={chip.cls}>{chip.label}</Chip> : <span className="faint">—</span>}</td>
                      <td className="num mono">{line?.status === 'PRICED' ? fmt2(line.result.landedCost) : '—'}</td>
                      <td className="num mono"><b>{line?.status === 'PRICED' ? fmt2(line.result.unitPrice) : '—'}</b></td>
                      <td className="num mono">{line?.status === 'PRICED' && line.result.margin != null ? pct(line.result.margin) : '—'}</td>
                      <td className="num mono">{total === null ? '—' : fmt2(total)}</td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="why" onClick={() => onWhy(row.id)} disabled={!line}>why?</button>
                          <button type="button" className="btn ghost small" onClick={() => quote.toggleKit(row.id)} title="A kit line is priced as the sum of its components">{row.components.filter((c) => c.partNumber.trim()).length ? `kit (${row.components.filter((c) => c.partNumber.trim()).length})` : '+ kit'}</button>
                          <button type="button" className="btn ghost small" onClick={() => quote.removeRow(row.id)} aria-label={`Remove ${row.partNumber || 'line'}`}>×</button>
                        </div>
                      </td>
                    </tr>
                    {row.kitOpen && (
                      <tr className="sub"><td colSpan={colCount}>
                        <div className="kit-editor">
                          <div className="small muted">Components of <b>{row.partNumber || 'this kit'}</b> — the kit's unit price is the sum of its component prices, each priced as a full line.</div>
                          {row.components.map((c) => (
                            <div className="kit-component-row" key={c.id}>
                              <input type="text" className="mono" list="parts" value={c.partNumber} onChange={(e) => quote.updateComponent(row.id, c.id, { partNumber: e.target.value })} placeholder="Component part number" aria-label="Component part" />
                              <input type="number" className="n" min="1" value={c.quantity} onChange={(e) => quote.updateComponent(row.id, c.id, { quantity: e.target.value })} aria-label="Component quantity" />
                              <input type="text" className="mono" value={c.ood} onChange={(e) => quote.updateComponent(row.id, c.id, { ood: e.target.value })} placeholder="Data origin" aria-label="Component data origin" />
                              <button type="button" className="btn ghost small" onClick={() => quote.removeComponent(row.id, c.id)} aria-label="Remove component">×</button>
                            </div>
                          ))}
                          <button type="button" className="btn link small" style={{ marginTop: 8 }} onClick={() => quote.addComponent(row.id)}>+ Add component</button>
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={colCount} className="muted" style={{ textAlign: 'center', padding: 26 }}>No lines yet — add one, or paste a list.</td></tr>}
            </tbody>
          </table>
        </div>
        {showBulk && <BulkAdd onAdd={quote.addRows} />}
        <div className="body small muted">Cost plus lines land the cost from the region's rules and add the region's default margin (adjust per line in <b>why?</b>). Price list and catalog lines are sell prices — no cost is shown unless a formula built it. Lines marked <b>re-price</b> changed after they were priced.</div>
      </div>
      <datalist id="parts">{Object.entries(quote.knownParts).map(([p, d]) => <option key={p} value={p}>{d}</option>)}</datalist>
    </>
  );
}
