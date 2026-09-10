import { useEffect, useState } from 'react';
import { fmt2, humanWhen, lineTotal, num, pct, ratePctInput, stepName } from '../format.js';
import { Callout, Chip, TypeChip } from '../components/ui.jsx';
import { useDebounced } from '../hooks.js';

const SW = { BASE: 'base', FACTOR: 'cp', ADDER: 'cp', PER_LINE: 'cp', RULE: 'pl', PERCENT: 'pl', FORMULA: 'cf' };
const isSkipped = (s) => Boolean(s.skipped || s.note?.skipped);
const REASON = {
  NO_FREIGHT: 'no freight for this book',
  CATALOG_RATE_IS_SELL_PRICE: 'catalog rate is already a negotiated sell price',
  RATE_ZERO: 'the matching row has a 0% rate',
  NO_MATCHING_ROW: 'no row matched this customer',
};

function howText(s) {
  const n = s.note || {};
  if (s.missing) return `missing — ${s.missing.reason}`;
  if (isSkipped(s)) return n.when ? `not applied — ${humanWhen(n.when)}` : `not applied — ${REASON[n.reason] || n.reason || ''}`;
  if (s.type === 'BASE') return `cost from ${n.source || 'the chosen candidate'}`;
  if (s.type === 'FACTOR') return `${fmt2(n.basisAmount)} (${(n.basis || []).map(stepName).join(' + ')}) × ${pct(n.rate)}${n.rateSource && n.rateSource !== 'CONFIG' ? ` from ${n.rateSource}` : ''}`;
  if (s.type === 'PER_LINE') return `${n.amount !== undefined ? fmt2(n.amount) : fmt2(num(s.delta) * num(n.perQuantity))} per order ÷ ${n.perQuantity}`;
  if (s.type === 'ADDER') return n.source === 'CONFIG' ? 'flat per unit' : `from ${n.source}`;
  if (s.type === 'RULE') return n.row ? `row ${n.row}${n.tierFrom !== undefined ? ` · tier from ${n.tierFrom}` : ''}` : n.source || '';
  if (s.type === 'PERCENT') return `${pct(n.rate)}${n.row ? ` for ${n.row}` : ''}${n.basis ? ` on ${n.basis.map(stepName).join(' + ')}` : ''}`;
  if (s.type === 'FORMULA') return 'no catalog row — fallback formula';
  return '';
}

/** Numbered calculation: one row per step, running total on the right, skipped steps muted. */
export function Calc({ steps = [], currency, finalLabel, finalValue }) {
  return (
    <div className="calc">
      {steps.map((s, i) => {
        const skipped = isSkipped(s) || s.missing;
        const d = num(s.delta);
        const sign = s.type === 'BASE' || s.type === 'RULE' || s.type === 'FORMULA' ? '' : d !== null && d < 0 ? '− ' : '+ ';
        return (
          <div className={`row ${skipped ? 'skip' : ''}`} key={`${s.id}-${i}`}>
            <span className="n">{i + 1}</span>
            <span>{sign}{stepName(s.id)}<span className="how">{howText(s)}</span></span>
            <span>{skipped ? <span className="amt d">—</span> : <><span className="amt d">{d !== null && d < 0 ? '−' : '+'}{fmt2(Math.abs(d ?? 0))}</span><span className="amt">{fmt2(s.runningTotal)}</span></>}</span>
          </div>
        );
      })}
      <div className="row final"><span className="n">=</span><span>{finalLabel}</span><span className="amt">{fmt2(finalValue, currency)}</span></div>
    </div>
  );
}

function OrderRules({ passes, currency }) {
  if (!passes?.length) return null;
  return (
    <div className="note"><b>Order rules:</b> {passes.map((p) => (p.kind === 'MIN_QTY' ? `MOQ ${p.min} (requested ${p.quantity}) — warning only` : p.mode === 'QUANTITY' ? `MOLV ${fmt2(p.min, currency)}: qty ${p.quantityFrom} → ${p.quantityTo}` : `MOLV ${fmt2(p.min, currency)}: ${fmt2(p.from)} → ${fmt2(p.to)} per unit`)).join(' · ')}</div>
  );
}

function CostPlus({ line, currency, regionConfig, onMargin, row }) {
  const t = line.trace;
  const chosen = t.costCandidate;
  const cands = t.costCandidates || (chosen ? [{ ...chosen, won: true, reason: chosen.selectedBy === 'USER' ? 'picked by user' : chosen.selectedBy?.startsWith('ACCESS_SEQUENCE') ? `first system in the ${t.stockClass || 'default'} cost order` : 'default candidate' }] : []);
  const seq = t.accessSequence || (Array.isArray(regionConfig?.costAccessSequence) ? regionConfig.costAccessSequence : regionConfig?.costAccessSequence?.[t.stockClass] || regionConfig?.costAccessSequence?.['*']) || [];
  const marginNow = num(t.sell?.margin ?? line.result.margin);
  const [marginPct, setMarginPct] = useState(marginNow === null ? '' : ratePctInput(marginNow));
  useEffect(() => { setMarginPct(marginNow === null ? '' : ratePctInput(marginNow)); }, [marginNow]);
  const send = useDebounced((v) => onMargin(v === '' ? undefined : String(Number(v) / 100)), 350);
  const change = (v) => { setMarginPct(v); send(v); };
  const landed = num(line.result.landedCost); const sell = num(line.result.unitPrice); const qty = num(line.result.quantity);
  const defaultMargin = regionConfig?.sell?.defaultMargin;
  return (
    <>
      <section>
        <h3>Cost used</h3>
        <div className="cand">
          {cands.map((c, i) => (
            <div className={`r ${c.won ? 'won' : 'lost'}`} key={i}>
              <div>
                <span className="mono"><b>{fmt2(c.value, c.currency)}</b></span> · {String(c.basis || '').replace(/_/g, ' ').toLowerCase()} from <b>{c.source?.system}</b> <span className="mono small muted">{c.source?.table}.{c.source?.field}</span>{c.validFrom ? ` · valid from ${c.validFrom}` : ''}
                <div className="why-l">{c.won ? '✓ ' : ''}{c.reason || ''}{c.confidence && c.confidence !== 'EXACT' ? <> · <span style={{ color: 'var(--warn)' }}>{String(c.confidence).toLowerCase()} confidence</span></> : null}</div>
              </div>
              <Chip kind={c.won ? 'good' : 'neutral'}>{c.won ? 'used' : 'not used'}</Chip>
            </div>
          ))}
          {cands.length === 0 && <div className="r lost"><div>No cost candidate</div></div>}
        </div>
        <div className="note">
          Cost source order for <b>{t.stockClass || 'this region'}</b>: <span className="seq">{seq.map((s, k) => <span key={k}><span className="s">{s}</span>{k < seq.length - 1 ? <span className="arr"> → </span> : null}</span>)}{seq.length === 0 && <span className="faint">not configured</span>}</span>
          {t.notes?.length ? <><br />{t.notes.join(' · ')}</> : null}
        </div>
      </section>
      <section>
        <h3>Cost build-up</h3>
        <div className="cards">
          {(t.steps || []).map((s) => <div className={`card ${isSkipped(s) ? 'na' : ''}`} key={s.id}><div className="k"><span className={`sw ${isSkipped(s) ? 'na' : SW[s.type] || 'cp'}`} />{stepName(s.id)}</div><div className="v">{isSkipped(s) ? 'n/a' : fmt2(s.delta)}</div></div>)}
        </div>
      </section>
      <section>
        <h3>Calculation</h3>
        <Calc steps={t.steps} currency={currency} finalLabel={`Landed cost per unit${(t.constraintPasses || []).some((p) => p.kind === 'FLOOR') ? ' (after order rules)' : ''}`} finalValue={line.result.landedCost} />
        <OrderRules passes={t.constraintPasses} currency={currency} />
      </section>
      <section>
        <h3>Sell price</h3>
        <div className="margin-row">
          <input type="number" step="0.5" min="0" max="90" value={marginPct} onChange={(e) => change(e.target.value)} aria-label="Margin %" disabled={!onMargin} />
          <input type="range" min="0" max="70" step="0.5" value={marginPct === '' ? 0 : marginPct} onChange={(e) => change(e.target.value)} aria-label="Margin slider" disabled={!onMargin} />
          <span className="mono"><b>{fmt2(line.result.unitPrice, currency)}</b></span>
        </div>
        <div className="note">
          Sell = landed cost ÷ (1 − margin). {defaultMargin !== undefined && defaultMargin !== null ? <>Region default {pct(defaultMargin)}</> : 'No region default margin'}{t.sell?.source === 'LINE_OVERRIDE' || row?.marginOverride !== undefined ? <> — overridden on this line · <button type="button" className="btn link small" onClick={() => onMargin(undefined)}>reset to default</button></> : null}.
          {landed !== null && sell !== null ? <> Margin per unit {fmt2(sell - landed, currency)}, line {fmt2((sell - landed) * qty, currency)}.</> : null}
          <span className="faint"> Moving the slider re-prices this line on the server.</span>
        </div>
      </section>
    </>
  );
}

function PriceList({ line, currency }) {
  const t = line.trace; const res = t.resolution || { candidates: [] };
  const attrs = Object.entries(t.attributes || {}).filter(([k, v]) => v !== undefined && v !== null && ['customer', 'tier', 'region', 'salesOrg'].includes(k));
  const reason = (c) => (c.won ? '✓ most specific match' : c.reason === 'OUTSIDE_VALIDITY' ? 'outside validity' : c.reason === 'CONDITION_NOT_MET' ? 'condition not met' : c.reason === 'AMBIGUOUS' ? 'ambiguous — same specificity as another row' : String(c.reason || '').startsWith('LESS_SPECIFIC') ? `less specific (${c.reason.split(':')[1]})` : c.reason || '');
  return (
    <>
      <section>
        <h3>Which row applied</h3>
        <div className="cand">
          {res.candidates.map((c, i) => (
            <div className={`r ${c.won ? 'won' : 'lost'}`} key={i}>
              <div><b>{c.description}</b> <span className="small muted">specificity {c.specificity}</span>
                <div className="why-l">{reason(c)}{c.tiers ? ` · tiers ${c.tiers.map((x) => `${x.from}+ ${fmt2(x.value)}`).join(' / ')}` : c.value !== undefined ? ` · ${fmt2(c.value)}` : ''}{c.validTo ? ` · until ${c.validTo}` : ''}</div>
              </div>
              <Chip kind={c.won ? 'good' : 'neutral'}>{c.won ? 'used' : 'not used'}</Chip>
            </div>
          ))}
        </div>
        <div className="note">
          {attrs.length ? <>Matched on {attrs.map(([k, v], i) => <span key={k}>{i ? ', ' : ''}{k} = <b>{String(v)}</b></span>)}. </> : null}
          {t.tier ? <>Quantity {line.result?.quantity} falls in the tier from <b>{t.tier.from}</b> → {fmt2(t.tier.value, currency)}. </> : null}
          More specific rows always win; equal specificity is an error, never a coin toss.
        </div>
      </section>
      {line.status === 'PRICED' && (
        <section>
          <h3>Calculation</h3>
          <Calc steps={t.steps} currency={currency} finalLabel={`Net unit price${(t.constraintPasses || []).length ? ' (after order rules)' : ''}`} finalValue={line.result.unitPrice} />
          <OrderRules passes={t.constraintPasses} currency={currency} />
        </section>
      )}
    </>
  );
}

function substitute(formula, used) {
  return String(formula || '').replace(/[A-Za-z_][\w.]*/g, (v) => (used && v in used ? String(used[v]) : v));
}

function Catalog({ line, currency, description }) {
  const t = line.trace; const checked = t.checked || [];
  const formula = t.formula && typeof t.formula === 'object' ? t.formula : t.formula ? { source: t.formula, used: null, value: null } : null;
  return (
    <>
      <section>
        <h3>Catalog or formula?</h3>
        <div className="cand">
          {checked.map((c, i) => (
            <div className={`r ${c.ok ? 'won' : 'lost'}`} key={i}>
              <div><span className="mono">{Object.entries(c.match || {}).map(([k, v]) => `${k} ${v}`).join(' · ')}</span> — {fmt2(c.rate, currency)}<div className="why-l">{c.ok ? '✓ exact match' : 'does not match this line'}</div></div>
              <Chip kind={c.ok ? 'good' : 'neutral'}>{c.ok ? 'used' : 'no match'}</Chip>
            </div>
          ))}
          <div className={`r ${t.source === 'FORMULA' ? 'won' : 'lost'}`}>
            <div><b>Fallback formula</b><div className="why-l">{t.source === 'FORMULA' ? '✓ no catalog row for this size — formula prices it' : line.status !== 'PRICED' && formula ? 'tried — see why there is no price' : 'not needed — a catalog row matched'}</div></div>
            <Chip kind={t.source === 'FORMULA' ? 'cf' : 'neutral'}>{t.source === 'FORMULA' ? 'used' : 'skipped'}</Chip>
          </div>
        </div>
        {formula && (t.source === 'FORMULA' || line.status !== 'PRICED') && (
          <>
            <div className="formula" style={{ marginTop: 10 }}>{formula.source}{formula.used ? <><span className="muted">{'\n= '}</span>{substitute(formula.source, formula.used)}<span className="muted"> = </span><b>{fmt2(formula.value)}</b></> : null}</div>
            {formula.used && (
              <dl className="kv" style={{ marginTop: 10 }}>
                {Object.entries(formula.used).map(([k, v]) => {
                  const ci = t.costInputs?.[k] || t.costInputs?.[k.replace(/^cost\./, '')];
                  return (
                    <div key={k} style={{ display: 'contents' }}>
                      <dt className="mono">{k}</dt>
                      <dd><span className="mono">{String(v)}</span> {ci ? <span className="small muted">{[ci.unit, ci.validFrom ? `valid from ${ci.validFrom}` : null, ci.source ? String(ci.source).toLowerCase() : null].filter(Boolean).join(' · ')}</span> : <span className="small muted">from the line{description ? ` (${description})` : ''}</span>}</dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </>
        )}
      </section>
      {line.status === 'PRICED' && (
        <section>
          <h3>Calculation</h3>
          <Calc steps={t.steps} currency={currency} finalLabel="Net unit price" finalValue={line.result.unitPrice} />
          {t.floor && <div className="note">Margin floor for this book: {pct(t.floor.rate)} on landed cost. {t.floor.breached ? <b style={{ color: 'var(--crit)' }}>Breached after discount ({pct(t.floor.realised)}).</b> : <>Respected ({pct(t.floor.realised)} realised).</>}</div>}
        </section>
      )}
    </>
  );
}

export default function WhyDrawer({ row, line, quote, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!row || !line) return null;
  const currency = line.result?.currency || quote.regionConfig?.currency || '';
  const bookName = line.book ? (quote.books?.find((b) => b.id === line.book)?.name || line.book) : null;
  const flags = (line.flags || []).filter((f) => line.status === 'PRICED' || f.code !== line.missing?.reason);
  const onMargin = line.technique === 'COST_PLUS' && line.status === 'PRICED' ? (m) => quote.repriceLine(row.id, { marginOverride: m }) : null;
  return (
    <div className="drawer-wrap">
      <button type="button" className="scrim" onClick={onClose} aria-label="Close" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Why this price — ${row.partNumber}`}>
        <div className="dhead">
          <div>
            <div className="part">{row.partNumber}</div>
            <div className="desc">{row.description || quote.knownParts[row.partNumber] || ''}</div>
            <div className="chips">
              <TypeChip technique={line.technique} />
              {line.trace?.region && <Chip>{line.trace.region}</Chip>}
              {line.trace?.stockClass && <Chip>{line.trace.stockClass}</Chip>}
              <Chip>Qty {line.result?.quantity ?? row.quantity}</Chip>
              {bookName && <Chip>{bookName}</Chip>}
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>Pricing type by {line.routedBy === 'USER' ? 'you (manual)' : line.routedBy === 'DEFAULT' ? 'default for the region' : `rule ${String(line.routedBy || '').split(':')[1]}`}{line.trace?.configVersions?.region || line.trace?.configVersion ? ` · rules v${line.trace.configVersions?.region || line.trace.configVersion}` : ''}{line.trace?.priceDate ? ` · price date ${line.trace.priceDate}` : ''}</div>
          </div>
          <div className="price">
            {line.status === 'PRICED' ? <><div className="v">{fmt2(line.result.unitPrice)}</div><div className="u">{currency} / unit</div>{line.result.landedCost != null && <div className="u">cost {fmt2(line.result.landedCost)}{line.result.margin != null ? ` · margin ${pct(line.result.margin)}` : ''}</div>}</> : <Chip kind="crit">{line.status === 'BLOCKED' ? 'Blocked' : 'Missing'}</Chip>}
            <div style={{ marginTop: 8 }}><button type="button" className="btn small" onClick={onClose}>Close</button></div>
          </div>
        </div>

        {line.status !== 'PRICED' && (
          <section>
            <h3>Why there is no price</h3>
            <Callout level="crit"><b>{line.missing?.reason || line.status}</b><br />{line.missing?.detail || 'The engine refused to price this line.'}</Callout>
            <p className="note">Nothing is ever priced at zero. Fix the input (or the rule) and price again.</p>
          </section>
        )}
        {flags.length > 0 && line.status === 'PRICED' && (
          <section>
            <h3>Attention</h3>
            <div className="callouts">{flags.map((f, i) => <Callout key={i} level={f.level}>{f.text}</Callout>)}</div>
          </section>
        )}

        {line.status === 'PRICED' && line.technique === 'COST_PLUS' && <CostPlus line={line} row={row} currency={currency} regionConfig={quote.regionConfig} onMargin={onMargin} />}
        {line.technique === 'PRICE_LIST' && line.trace?.resolution && <PriceList line={line} currency={currency} />}
        {line.technique === 'CATALOG_FORMULA' && line.trace?.checked && <Catalog line={line} currency={currency} description={row.description} />}
        {line.status === 'PRICED' && line.trace?.kit && (
          <section>
            <h3>Kit components</h3>
            <div className="cand">{(line.trace.components || []).map((c, i) => <div className="r" key={i}><div><span className="mono">{c.partNumber}</span> — {c.status === 'PRICED' ? `${c.result.quantity} × ${fmt2(c.result.unitPrice)} ${c.result.currency}` : c.missing?.reason || c.status}</div></div>)}</div>
          </section>
        )}

        <section>
          <h3>Sent to the customer as</h3>
          <dl className="kv">
            <dt>Unit price</dt><dd className="mono">{line.status === 'PRICED' ? fmt2(line.result.unitPrice, currency) : '—'}</dd>
            <dt>Quantity</dt><dd className="mono">{line.result?.quantity ?? row.quantity}</dd>
            <dt>Line total</dt><dd className="mono">{line.status === 'PRICED' ? fmt2(lineTotal(line), currency) : '—'}</dd>
            <dt>Trace id</dt><dd className="mono small">{line.documentId || '—'}</dd>
          </dl>
        </section>
      </aside>
    </div>
  );
}
