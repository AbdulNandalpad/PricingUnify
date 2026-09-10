import { useState } from 'react';
import { Chip, ErrorBox, ReadOnlyNote } from '../components/ui.jsx';
import RegionsSheet from './RegionsSheet.jsx';
import PriceListsSheet from './PriceListsSheet.jsx';
import CatalogSheet from './CatalogSheet.jsx';
import RoutingSheet from './RoutingSheet.jsx';
import SuppliersSheet from './SuppliersSheet.jsx';
import * as api from '../api.js';

const TABS = [
  ['regions', 'Regions · cost plus', 'cp'],
  ['pricelists', 'Price lists', 'pl'],
  ['catalogs', 'Catalog + formula', 'cf'],
  ['routing', 'Which type applies', null],
  ['suppliers', 'Suppliers', null],
];

/** Sticky banner: server-truthful change count across every open draft. */
export function DraftBanner({ registry, isAdmin, onGoLive, onDiscardAll }) {
  if (registry.draftCount === 0) return null;
  const n = registry.changeCount;
  return (
    <div className="banner" role="status">
      <strong>Unsaved changes</strong>
      <span className="muted small">{registry.draftCount === 1 ? 'a draft' : `${registry.draftCount} drafts`} · {n} change{n === 1 ? '' : 's'} — nothing prices with them until you go live.</span>
      <span className="spacer">
        {isAdmin && <button type="button" className="btn small" onClick={onDiscardAll}>Discard</button>}
        <button type="button" className="btn primary small" onClick={onGoLive}>Review &amp; go live →</button>
      </span>
    </div>
  );
}

export default function PricingRules({ asOf, registry, isAdmin, onGoLive, region, toast }) {
  const [tab, setTab] = useState('regions');
  const [error, setError] = useState(null);
  const sheetProps = { asOf, registry, isAdmin, toast, region };

  const discardAll = async () => {
    if (!window.confirm(`Discard ${registry.draftCount === 1 ? 'the open draft' : `all ${registry.draftCount} drafts`}? Every unsaved change is lost.`)) return;
    setError(null);
    try {
      for (const e of registry.drafts) await api.discardDraft({ kind: e.kind, key: e.key, version: e.draft.version });
      await registry.scanAll();
      toast('Drafts discarded — back to the live rules');
    } catch (e) { setError(e); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Pricing rules</h1><p>Every number behind a price lives here, as tables you can edit. Changes wait as a draft until you go live.</p></div>
        <div className="actions">{registry.liveVersion && <Chip>{registry.draftCount ? `Editing draft of v${registry.liveVersion}` : `Live v${registry.liveVersion}`}</Chip>}</div>
      </div>
      <DraftBanner registry={registry} isAdmin={isAdmin} onGoLive={onGoLive} onDiscardAll={discardAll} />
      <ErrorBox error={error} />
      <ReadOnlyNote isAdmin={isAdmin} />
      <div className="tabs" role="tablist">
        {TABS.map(([k, l, c]) => (
          <button type="button" key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {l}{c ? <span className={`sw ${c}`} style={{ marginLeft: 6 }} /> : null}
          </button>
        ))}
      </div>
      {tab === 'regions' && <RegionsSheet {...sheetProps} />}
      {tab === 'pricelists' && <PriceListsSheet {...sheetProps} />}
      {tab === 'catalogs' && <CatalogSheet {...sheetProps} />}
      {tab === 'routing' && <RoutingSheet {...sheetProps} />}
      {tab === 'suppliers' && <SuppliersSheet {...sheetProps} />}
    </>
  );
}
