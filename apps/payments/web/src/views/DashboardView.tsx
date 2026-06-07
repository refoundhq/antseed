import { useEffect, useMemo, useState } from 'react';
import type { BalanceData, PaymentConfig } from '../types';
import {
  getBuyerUsage,
  getNetworkStats,
  type ChannelData,
  type BuyerUsageChannelPoint,
  type BuyerUsageTotals,
  type NetworkStatsResponse,
} from '../api';
import { useChannels } from '../hooks/useChannels';
import { UsageChart } from '../components/UsageChart';
import {
  formatCompact,
  formatNumber,
  formatTimestampDate,
  formatUsd,
  bigintFromString,
  timestampToMs,
} from '../utils/format';
import './DashboardView.scss';

interface DashboardViewProps {
  config: PaymentConfig | null;
  balance: BalanceData | null;
  onOpenDeposit: () => void;
  onOpenWithdraw: () => void;
  onOpenActivity: () => void;
}

const EMPTY_CHANNELS: BuyerUsageChannelPoint[] = [];
const USAGE_WINDOWS = [7, 30, 90] as const;
const DEFAULT_USAGE_WINDOW = 30;

function getChannelStatusLabel(channel: ChannelData): string {
  if (channel.status === 2) return 'Settled';
  if (channel.status === 3) return 'Timed out';
  if (channel.status === 0) return 'Closed';
  if (channel.closeRequestedAt > 0) return 'Closing';
  return 'Active';
}

export function DashboardView({
  config,
  balance,
  onOpenDeposit,
  onOpenWithdraw,
  onOpenActivity,
}: DashboardViewProps) {
  const { channels, history } = useChannels(config);
  const [buyerUsage, setBuyerUsage] = useState<BuyerUsageTotals | null>(null);
  const [buyerUsageError, setBuyerUsageError] = useState(false);
  const [networkStats, setNetworkStats] = useState<NetworkStatsResponse | null>(null);
  const [networkStatsError, setNetworkStatsError] = useState(false);
  const [usageWindow, setUsageWindow] = useState<number>(DEFAULT_USAGE_WINDOW);
  const networkStatsUrl = config?.networkStatsUrl ?? null;

  useEffect(() => {
    let cancelled = false;
    getBuyerUsage()
      .then((totals) => {
        if (cancelled) return;
        setBuyerUsage(totals);
        setBuyerUsageError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setBuyerUsageError(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!networkStatsUrl) {
      setNetworkStats(null);
      setNetworkStatsError(false);
      return;
    }
    let cancelled = false;
    getNetworkStats(networkStatsUrl)
      .then((stats) => {
        if (cancelled) return;
        setNetworkStats(stats);
        setNetworkStatsError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setNetworkStats(null);
        setNetworkStatsError(true);
      });
    return () => { cancelled = true; };
  }, [networkStatsUrl]);

  const available = formatUsd(balance?.available);
  const reserved = formatUsd(balance?.reserved);
  const totalBalance = formatUsd(balance?.total);
  const networkTokens = bigintFromString(networkStats?.totals.totalInputTokens) + bigintFromString(networkStats?.totals.totalOutputTokens);
  const personalTokens = bigintFromString(buyerUsage?.totalInputTokens) + bigintFromString(buyerUsage?.totalOutputTokens);
  const usageChannels = buyerUsage?.channels ?? EMPTY_CHANNELS;
  const recentChannels = useMemo(
    () => [...channels, ...history]
      .slice()
      .sort((a, b) => timestampToMs(b.reservedAt) - timestampToMs(a.reservedAt))
      .slice(0, 3),
    [channels, history],
  );

  return (
    <div className="portal-overview">
      {buyerUsageError && (
        <div className="portal-inline-warning">
          <span aria-hidden="true" />
          Usage data is unavailable.
        </div>
      )}

      <section className="overview-balance">
        <div className="overview-balance-main">
          <div className="portal-kicker">Available balance</div>
          <div className="overview-balance-value">
            ${available}
            <span>USDC</span>
          </div>
          <p>
            ${totalBalance} total · ${reserved} in {buyerUsage?.activeChannels ?? 0} active channels
          </p>
          <div className="overview-actions">
            <button type="button" className="portal-primary-btn" onClick={onOpenDeposit}>Deposit</button>
            <button type="button" className="portal-secondary-btn" onClick={onOpenWithdraw}>Withdraw</button>
          </div>
        </div>
      </section>

      <section className="overview-section" aria-labelledby="overview-usage-title">
        <div className="overview-section-head">
          <h2 className="overview-section-title" id="overview-usage-title">Your usage</h2>
          <p>Account-level requests, tokens, sellers, and channel activity.</p>
        </div>

        <section className="overview-stat-row" aria-label="Usage totals">
          <div>
            <div className="portal-kicker">Requests (all-time)</div>
            <strong>{formatNumber(buyerUsage?.totalRequests ?? 0)}</strong>
          </div>
          <div>
            <div className="portal-kicker">Tokens (all-time)</div>
            <strong>{formatCompact(personalTokens)}</strong>
          </div>
          <div>
            <div className="portal-kicker">Sellers used</div>
            <strong>{formatNumber(buyerUsage?.uniqueSellers ?? 0)}</strong>
          </div>
          <div>
            <div className="portal-kicker">Active channels</div>
            <strong>{formatNumber(buyerUsage?.activeChannels ?? 0)}</strong>
          </div>
        </section>

        <section className="overview-lower-grid">
          <div>
            <div className="usage-head">
              <div className="portal-kicker">Usage · daily</div>
              <div className="usage-window" role="group" aria-label="Usage window">
                {USAGE_WINDOWS.map((window) => (
                  <button
                    key={window}
                    type="button"
                    className={`usage-window-opt${usageWindow === window ? ' usage-window-opt--active' : ''}`}
                    aria-pressed={usageWindow === window}
                    onClick={() => setUsageWindow(window)}
                  >
                    {window}D
                  </button>
                ))}
              </div>
            </div>
            <UsageChart channels={usageChannels} days={usageWindow} />
          </div>
          <div className="overview-recent">
            <div className="overview-recent-head">
              <div className="portal-kicker">Recent activity</div>
              <button type="button" onClick={onOpenActivity}>View all →</button>
            </div>
            {recentChannels.length === 0 ? (
              <p>No channel activity yet.</p>
            ) : (
              <div className="overview-recent-list">
                {recentChannels.map((channel) => (
                  <div className="overview-recent-row" key={channel.channelId}>
                    <div>
                      <strong>{getChannelStatusLabel(channel)}</strong>
                      <span>{formatTimestampDate(channel.reservedAt)}</span>
                    </div>
                    <div>
                      <strong>${formatUsd(channel.settled)}</strong>
                      <span>of ${formatUsd(channel.deposit)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </section>

      {(networkStats || (networkStatsUrl && networkStatsError)) && (
        <section className="overview-section overview-section--network" aria-labelledby="overview-network-title">
          <div className="overview-section-head">
            <h2 className="overview-section-title" id="overview-network-title">Network activity</h2>
            <p>Aggregate activity across sellers on the AntSeed network.</p>
          </div>

          {networkStats && (
            <section className="overview-stat-row overview-stat-row--network" aria-label="Network totals">
              <div>
                <div className="portal-kicker">Active peers</div>
                <strong>{formatNumber(networkStats.totals.activePeers)}</strong>
              </div>
              <div>
                <div className="portal-kicker">Requests</div>
                <strong>{formatCompact(bigintFromString(networkStats.totals.totalRequests))}</strong>
              </div>
              <div>
                <div className="portal-kicker">Tokens</div>
                <strong>{formatCompact(networkTokens)}</strong>
              </div>
              <div>
                <div className="portal-kicker">Settlements</div>
                <strong>{formatNumber(networkStats.totals.totalSettlements)}</strong>
              </div>
            </section>
          )}

          {networkStatsUrl && networkStatsError && (
            <div className="portal-inline-warning">
              <span aria-hidden="true" />
              Network stats unavailable.
            </div>
          )}
        </section>
      )}
    </div>
  );
}
