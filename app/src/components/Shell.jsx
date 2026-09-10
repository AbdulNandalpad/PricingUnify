import { API_MODE, DEMO_USERS } from '../api.js';

const SCREENS = [
  { id: 'price', label: 'Price calculator', group: 'Work' },
  { id: 'rules', label: 'Pricing rules', group: 'Configure' },
  { id: 'golive', label: 'Go live & history', group: 'Configure' },
];

export function TopBar({ entity, region, liveVersion, dirty, user, onUser, me }) {
  const role = me?.roles?.includes('PricingAdmin') ? 'Pricing admin' : me ? 'Viewer' : '…';
  return (
    <header className="topbar">
      <div className="brand">
        <span className="name">PricingUnify</span>
        <span className="tag">TSS Pricing Engine</span>
        {API_MODE === 'mock' && <span className="mock-badge" title="VITE_API_MODE=mock — sample data, nothing reaches a backend">mock data</span>}
      </div>
      <div className="context">
        <span className="hide-m">{[entity, region].filter(Boolean).join(' · ')}</span>
        <span className="live" title={dirty ? 'A draft with unsaved changes exists' : 'Rules in force'}>
          <span className={`dot ${dirty ? 'warn' : ''}`} />
          <span>{liveVersion ? `v${liveVersion} live` : 'no live version'}{dirty ? ' · draft open' : ''}</span>
        </span>
        <span className="signed hide-m">
          <span>Signed in as</span>
          <select aria-label="Signed in as" value={user} onChange={(e) => onUser(e.target.value)}>
            {Object.entries(DEMO_USERS).map(([id, u]) => <option key={id} value={id}>{u.label}</option>)}
          </select>
          <span className="faint">{role}</span>
        </span>
      </div>
    </header>
  );
}

export function SideNav({ screen, onScreen, draftCount }) {
  return (
    <nav className="side" aria-label="Sections">
      {SCREENS.map((s, i) => {
        const heading = s.group !== SCREENS[i - 1]?.group ? <div key={`g-${s.group}`} className="label group">{s.group}</div> : null;
        return [
          heading,
          <button key={s.id} type="button" className={screen === s.id ? 'active' : ''} onClick={() => onScreen(s.id)} aria-current={screen === s.id ? 'page' : undefined}>
            {s.label}
            {s.id === 'golive' && draftCount > 0 ? <span className="count">{draftCount === 1 ? 'draft' : `${draftCount} drafts`}</span> : null}
          </button>,
        ];
      })}
      <div className="mode small faint">Light theme · white + navy</div>
    </nav>
  );
}
