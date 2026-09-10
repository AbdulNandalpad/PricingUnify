import { useCallback, useEffect, useState } from 'react';
import * as api from './api.js';
import { SideNav, TopBar } from './components/Shell.jsx';
import { ErrorBox, useToast } from './components/ui.jsx';
import PriceCalculator from './calculator/PriceCalculator.jsx';
import WhyDrawer from './calculator/WhyDrawer.jsx';
import { useQuote } from './calculator/useQuote.js';
import PricingRules from './rules/PricingRules.jsx';
import { useDraftRegistry } from './rules/drafts.js';
import GoLive from './golive/GoLive.jsx';
import './App.css';

/** Roles come from the server (`GET whoami`), never from the picker label. */
function useSession() {
  const [user, setUserState] = useState(api.getCurrentUser());
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const setUser = useCallback((u) => { api.setCurrentUser(u); setUserState(u); setMe(null); setError(null); }, []);
  useEffect(() => {
    let cancelled = false;
    api.whoami().then((m) => { if (!cancelled) setMe(m); }).catch((e) => { if (!cancelled) { setError(e); setMe({ id: user, roles: [] }); } });
    return () => { cancelled = true; };
  }, [user]);
  return { user, setUser, me, error, isAdmin: Boolean(me?.roles?.includes('PricingAdmin')), ready: me !== null };
}

export default function App() {
  const [screen, setScreen] = useState('price');
  const session = useSession();
  const registry = useDraftRegistry({ ready: session.ready, user: session.user });
  const quote = useQuote({ user: session.user, ready: session.ready });
  const [whyRowId, setWhyRowId] = useState(null);
  const [toast, showToast] = useToast();

  const whyRow = quote.rows.find((r) => r.id === whyRowId) || null;
  const whyLine = whyRow ? quote.lineFor(whyRow) : null;
  const quoteView = { ...quote, books: [...registry.books['price-list'], ...registry.books['catalog-book']] };
  const closeWhy = useCallback(() => setWhyRowId(null), []);

  const priceAllWithToast = async () => { const res = await quote.priceAll(); if (res) showToast(`Priced ${res.items.length} line${res.items.length === 1 ? '' : 's'} against ${res.config?.region ? `v${res.config.region}` : 'the live rules'}`); };

  return (
    <div className="shell">
      <TopBar entity={quote.results?.entityLabel || quote.route?.entityLabel || null} region={quote.region} liveVersion={registry.liveVersion} dirty={registry.draftCount > 0} user={session.user} onUser={session.setUser} me={session.me} />
      <SideNav screen={screen} onScreen={setScreen} draftCount={registry.draftCount} />
      <main>
        <ErrorBox error={session.error} />
        {screen === 'price' && <PriceCalculator quote={{ ...quoteView, priceAll: priceAllWithToast }} onWhy={setWhyRowId} selectedRowId={whyRowId} />}
        {screen === 'rules' && <PricingRules asOf={quote.priceDate} registry={registry} isAdmin={session.isAdmin} region={quote.region} onGoLive={() => setScreen('golive')} toast={showToast} />}
        {screen === 'golive' && <GoLive quote={quoteView} registry={registry} isAdmin={session.isAdmin} toast={showToast} />}
      </main>
      {whyRow && whyLine && <WhyDrawer row={whyRow} line={whyLine} quote={quoteView} onClose={closeWhy} />}
      {toast}
    </div>
  );
}
