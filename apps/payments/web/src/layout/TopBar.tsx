import type { TabId } from './Sidebar';
import type { BalanceData } from '../types';
import { formatUsd, truncateAddress } from '../utils/format';

interface TopBarProps {
  activeTab: TabId;
  balance: BalanceData | null;
  buyerEvmAddress: string | null;
  atRisk: boolean;
  isDark: boolean;
  onToggleTheme: () => void;
  onOpenWallet: () => void;
}

const TAB_TITLES: Record<TabId, string> = {
  overview: 'Overview',
  rewards:  '$ANTS',
  'diem-rewards': 'DIEM $ANTS',
  activity: 'Activity',
  settings: 'Settings',
};

const TAB_SUBTITLES: Record<TabId, string> = {
  overview: 'Your AntSeed account at a glance.',
  rewards:  '$ANTS earned from AntSeed network usage.',
  'diem-rewards': '$ANTS earned from DIEM staking.',
  activity: 'Settlements and channel closes.',
  settings: 'Wallet, network, and appearance.',
};

function SignerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 8.4l2 2 4-4.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 2V3.5M8 12.5V14M2 8H3.5M12.5 8H14M3.8 3.8L4.8 4.8M11.2 11.2L12.2 12.2M3.8 12.2L4.8 11.2M11.2 4.8L12.2 3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.5 10A5.5 5.5 0 016 2.5 5.5 5.5 0 108 13.5a5.5 5.5 0 005.5-3.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function TopBar({
  activeTab,
  balance,
  buyerEvmAddress,
  atRisk,
  isDark,
  onToggleTheme,
  onOpenWallet,
}: TopBarProps) {
  const total = balance ? parseFloat(balance.total) : null;

  return (
    <header className="dash-topbar">
      <div className="dash-topbar-titles">
        <div className="dash-topbar-title">{TAB_TITLES[activeTab]}</div>
        <div className="dash-topbar-subtitle">{TAB_SUBTITLES[activeTab]}</div>
      </div>
      <div className="dash-topbar-right">
        <button
          type="button"
          className="dash-topbar-theme-toggle"
          onClick={onToggleTheme}
          title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {isDark ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          type="button"
          className={`dash-topbar-account${atRisk ? ' dash-topbar-account--risk' : ''}`}
          onClick={onOpenWallet}
          title={atRisk
            ? 'Action needed: authorize a recovery wallet to protect your funds'
            : 'AntSeed account and wallet settings'}
          aria-label={atRisk
            ? 'Account settings: action needed, authorize a recovery wallet'
            : 'Open AntSeed account settings'}
        >
          <span className="dash-topbar-account-avatar">
            <SignerIcon />
            {atRisk && <span className="dash-topbar-account-badge" aria-hidden="true" />}
          </span>
          <span className="dash-topbar-account-text">
            <span className="dash-topbar-account-balance">
              {total !== null ? `$${formatUsd(total)}` : '—'}
            </span>
            <span className="dash-topbar-account-addr">
              {atRisk ? 'Authorize wallet' : buyerEvmAddress ? truncateAddress(buyerEvmAddress) : 'AntSeed account'}
            </span>
          </span>
          <span className="dash-topbar-account-chevron"><ChevronIcon /></span>
        </button>
      </div>
    </header>
  );
}
