import { useEffect, useState } from 'react';
import { TYPES } from '../format.js';
import { describeError } from '../api.js';

export function Field({ label, hint, children, inline, className = '' }) {
  return (
    <label className={`field ${inline ? 'inline' : ''} ${className}`}>
      <span>{label}{hint ? <span className="faint"> {hint}</span> : null}</span>
      {children}
    </label>
  );
}

export function Chip({ kind = 'neutral', children, title, onRemove }) {
  return (
    <span className={`chip ${kind}`} title={title}>
      {children}
      {onRemove ? <button type="button" className="x" onClick={onRemove} aria-label="Remove">×</button> : null}
    </span>
  );
}

export function TypeChip({ technique }) {
  const t = TYPES[technique];
  return t ? <Chip kind={t.code}>{t.label}</Chip> : null;
}

export function Panel({ title, sub, actions, children, className = '', mb = true }) {
  return (
    <section className={`panel ${mb ? 'mb' : ''} ${className}`}>
      {(title || actions) && (
        <div className="head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {sub ? <div className="small muted">{sub}</div> : null}
          </div>
          {actions ? <div className="actions">{actions}</div> : null}
        </div>
      )}
      {children}
    </section>
  );
}

export function Callout({ level = 'warn', children, className = '' }) {
  const cls = level === 'crit' ? 'crit' : level === 'info' ? 'info' : level === 'good' ? 'good' : '';
  return <div className={`callout ${cls} ${className}`}>{children}</div>;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      {describeError(error)}
      {onRetry ? <> <button type="button" className="btn link" onClick={onRetry}>Try again</button></> : null}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ what = 'Loading' }) {
  return <div className="muted small saving" aria-live="polite">{what}…</div>;
}

/** One toast at a time, auto-dismissing. `useToast()` returns [node, show]. */
export function useToast() {
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    if (!msg) return undefined;
    const t = setTimeout(() => setMsg(null), 2400);
    return () => clearTimeout(t);
  }, [msg]);
  const node = <div className={`toast ${msg ? 'show' : ''}`} role="status" aria-live="polite">{msg}</div>;
  return [node, setMsg];
}

/** Read-only guard: viewers see the same sheets, every edit control disabled. */
export function ReadOnlyNote({ isAdmin }) {
  if (isAdmin) return null;
  return <Callout level="info" className="mb">You can read every rule here. Editing, discarding and going live need the <b>PricingAdmin</b> role — sign in as <b>bob</b> to try.</Callout>;
}
