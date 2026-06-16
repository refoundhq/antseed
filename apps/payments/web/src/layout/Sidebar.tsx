import type { ReactNode } from 'react';

export type TabId = 'overview' | 'rewards' | 'diem-rewards' | 'activity' | 'settings';

interface SidebarProps {
  activeTab: TabId;
  onSelect: (tab: TabId) => void;
}

interface NavItem {
  id: TabId;
  label: string;
  icon: ReactNode;
}

function AntIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 9.625C14.9665 9.625 15.75 8.763 15.75 7.7C15.75 6.637 14.9665 5.775 14 5.775C13.0335 5.775 12.25 6.637 12.25 7.7C12.25 8.763 13.0335 9.625 14 9.625Z" fill="currentColor" />
      <path d="M14 15.4C15.353 15.4 16.45 14.146 16.45 12.6C16.45 11.054 15.353 9.8 14 9.8C12.647 9.8 11.55 11.054 11.55 12.6C11.55 14.146 12.647 15.4 14 15.4Z" fill="currentColor" />
      <path d="M14 23.45C15.74 23.45 17.15 21.57 17.15 19.25C17.15 16.93 15.74 15.05 14 15.05C12.26 15.05 10.85 16.93 10.85 19.25C10.85 21.57 12.26 23.45 14 23.45Z" fill="currentColor" />
      <path opacity="0.6" d="M12.95 5.95L9.8 2.1" stroke="currentColor" strokeWidth="0.6" strokeLinecap="round" />
      <path opacity="0.6" d="M15.05 5.95L18.2 2.1" stroke="currentColor" strokeWidth="0.6" strokeLinecap="round" />
      <circle cx="9.8" cy="2.1" r="0.875" fill="currentColor" />
      <circle cx="18.2" cy="2.1" r="0.875" fill="currentColor" />
      <path opacity="0.4" d="M12.25 11.2L6.125 7.7" stroke="currentColor" strokeWidth="0.52" strokeLinecap="round" />
      <path opacity="0.4" d="M15.75 11.2L21.875 7.7" stroke="currentColor" strokeWidth="0.52" strokeLinecap="round" />
      <circle cx="6.3" cy="7.7" r="0.875" fill="currentColor" />
      <circle cx="21.7" cy="7.7" r="0.875" fill="currentColor" />
    </svg>
  );
}

function OverviewIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1" strokeLinejoin="round" />
      <rect x="10" y="2.5" width="5.5" height="5.5" rx="1" strokeLinejoin="round" />
      <rect x="2.5" y="10" width="5.5" height="5.5" rx="1" strokeLinejoin="round" />
      <rect x="10" y="10" width="5.5" height="5.5" rx="1" strokeLinejoin="round" />
    </svg>
  );
}

function RewardsIcon() {
  return <AntIcon size={18} />;
}

function DiemRewardsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.35" />
      <path d="M6.25 6.1H9.05C11.15 6.1 12.75 7.45 12.75 9C12.75 10.55 11.15 11.9 9.05 11.9H6.25V6.1Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      <path d="M8.15 6.1V11.9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="4.25" width="15" height="9.5" rx="1.25" />
      <circle cx="9" cy="9" r="2" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M3 6H9.5M12.5 6H15M3 12H5.5M8.5 12H15" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
      <circle cx="11" cy="6" r="1.7" stroke="currentColor" strokeWidth="1.35" />
      <circle cx="7" cy="12" r="1.7" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: <OverviewIcon /> },
  { id: 'rewards',  label: '$ANTS',  icon: <RewardsIcon /> },
  { id: 'diem-rewards',  label: 'DIEM $ANTS',  icon: <DiemRewardsIcon /> },
  { id: 'activity', label: 'Activity', icon: <ActivityIcon /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon /> },
];

export function Sidebar({ activeTab, onSelect }: SidebarProps) {
  return (
    <aside className="dash-sidebar">
      <div className="dash-sidebar-brand">
        <span className="dash-sidebar-brand-icon" aria-hidden="true"><AntIcon size={20} /></span>
        <span className="dash-sidebar-title">AntSeed Portal</span>
      </div>

      <nav className="dash-sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`dash-sidebar-item${activeTab === item.id ? ' dash-sidebar-item--active' : ''}`}
            onClick={() => onSelect(item.id)}
          >
            <span className="dash-sidebar-item-icon">{item.icon}</span>
            <span className="dash-sidebar-item-label">{item.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
