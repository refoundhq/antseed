import { useEffect, useMemo, useState } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import type { BalanceData, PaymentConfig } from '../types';
import {
  getBuyerUsage,
  getEmissionsPending,
  getNetworkStats,
  type ChannelData,
  type BuyerUsageChannelPoint,
  type BuyerUsageTotals,
  type NetworkStatsResponse,
} from '../api';
import { useChannels } from '../hooks/useChannels';
import { UsageChart } from '../components/UsageChart';
import {
  formatAntsAmount,
  formatCompact,
  formatNumber,
  formatTimestampDate,
  formatUsd,
  bigintFromString,
  timestampToMs,
} from '../utils/format';
import { getDiemPendingTotal, loadDiemRewardSnapshot } from '../utils/diemRewards';
import './DashboardView.scss';

interface DashboardViewProps {
  config: PaymentConfig | null;
  balance: BalanceData | null;
  onOpenDeposit: () => void;
  onOpenWithdraw: () => void;
  onOpenRewards: () => void;
  onOpenDiemRewards: () => void;
  onOpenActivity: () => void;
}

const EMPTY_CHANNELS: BuyerUsageChannelPoint[] = [];
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const USAGE_WINDOW_DAYS = 14;

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
  onOpenRewards,
  onOpenDiemRewards,
  onOpenActivity,
}: DashboardViewProps) {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { channels, history } = useChannels(config);
  const [buyerUsage, setBuyerUsage] = useState<BuyerUsageTotals | null>(null);
  const [buyerUsageError, setBuyerUsageError] = useState(false);
  const [networkStats, setNetworkStats] = useState<NetworkStatsResponse | null>(null);
  const [networkStatsError, setNetworkStatsError] = useState(false);
  const [claimableAnts, setClaimableAnts] = useState<bigint>(0n);
  const [diemClaimableAnts, setDiemClaimableAnts] = useState<bigint>(0n);
  const [diemRewardsLoaded, setDiemRewardsLoaded] = useState(false);
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
    if (!config?.evmAddress) {
      setClaimableAnts(0n);
      return;
    }
    let cancelled = false;
    getEmissionsPending(config.evmAddress)
      .then((pending) => {
        if (cancelled) return;
        const total = pending.rows.reduce((sum, row) => {
          if (row.isCurrent) return sum;
          return sum + bigintFromString(row.seller.amount) + bigintFromString(row.buyer.amount);
        }, 0n);
        setClaimableAnts(total);
      })
      .catch(() => {
        if (!cancelled) setClaimableAnts(0n);
      });
    return () => { cancelled = true; };
  }, [config?.evmAddress]);

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

  useEffect(() => {
    if (!isConnected || !address || !publicClient) {
      setDiemClaimableAnts(0n);
      setDiemRewardsLoaded(false);
      return;
    }
    let cancelled = false;
    loadDiemRewardSnapshot(publicClient, address as `0x${string}`)
      .then((snapshot) => {
        if (cancelled) return;
        setDiemClaimableAnts(getDiemPendingTotal(snapshot));
        setDiemRewardsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setDiemClaimableAnts(0n);
        setDiemRewardsLoaded(false);
      });
    return () => { cancelled = true; };
  }, [address, isConnected, publicClient]);

  const available = formatUsd(balance?.available);
  const reserved = formatUsd(balance?.reserved);
  const totalBalance = formatUsd(balance?.total);
  const totalClaimableRewards = claimableAnts + diemClaimableAnts;
  const rewardSourceLabel = diemRewardsLoaded ? 'network emissions + DIEM' : 'network emissions';
  const networkTokens = bigintFromString(networkStats?.totals.totalInputTokens) + bigintFromString(networkStats?.totals.totalOutputTokens);
  const personalTokens = bigintFromString(buyerUsage?.totalInputTokens) + bigintFromString(buyerUsage?.totalOutputTokens);
  const usageCutoff = Date.now() - USAGE_WINDOW_DAYS * MS_PER_DAY;
  const usageChannels = (buyerUsage?.channels ?? EMPTY_CHANNELS).filter((channel) => {
    const stamp = channel.updatedAt || channel.reservedAt;
    return stamp > usageCutoff;
  });
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
          Couldn&apos;t refresh — showing last known data
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

        <div className="overview-reward-card">
          <div className="portal-kicker">Claimable rewards</div>
          <div className="overview-reward-value">
            <span className="overview-reward-line" />
            {formatAntsAmount(totalClaimableRewards)} $ANTS
          </div>
          <p>{rewardSourceLabel}</p>
          <div className="overview-reward-actions">
            <button type="button" className="portal-primary-btn" onClick={onOpenRewards}>
              View $ANTS
            </button>
            <button type="button" className="portal-secondary-btn" onClick={onOpenDiemRewards}>
              DIEM $ANTS
            </button>
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
            <div className="portal-kicker">Usage · last 14 days</div>
            <UsageChart channels={usageChannels} days={USAGE_WINDOW_DAYS} />
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
