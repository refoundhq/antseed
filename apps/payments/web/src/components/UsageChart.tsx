import { useMemo } from 'react';
import type { BuyerUsageChannelPoint } from '../api';
import { formatCompact, formatNumber, formatTimestampDate, formatUsd } from '../utils/format';
import './UsageChart.scss';

interface UsageChartProps {
  channels: BuyerUsageChannelPoint[];
  days?: number;
}

interface DayBucket {
  t: number;
  fullDate: string;
  requests: number;
  tokens: number;
  spendUsd: number;
}

const DAY_MS = 86_400_000;
const FULL_DATE_OPTIONS = { weekday: 'short', month: 'short', day: 'numeric' } as const;

export function bucketByDay(channels: BuyerUsageChannelPoint[], days = 14): DayBucket[] {
  const now = Date.now();
  const cutoff = now - days * DAY_MS;
  const active = channels.filter((channel) => channel.requestCount > 0);
  const map = new Map<number, DayBucket>();

  for (const channel of active) {
    const stamp = channel.updatedAt || channel.reservedAt;
    if (!Number.isFinite(stamp) || stamp <= 0) continue;
    const t = Math.floor(stamp / DAY_MS) * DAY_MS;
    if (t < cutoff) continue;

    let tokens = 0;
    try {
      tokens = Number(BigInt(channel.inputTokens || '0') + BigInt(channel.outputTokens || '0'));
    } catch {
      // skip malformed token totals
    }

    const existing = map.get(t);
    if (existing) {
      existing.requests += channel.requestCount;
      existing.tokens += tokens;
      existing.spendUsd += estimateSpend(tokens);
    } else {
      map.set(t, {
        t,
        fullDate: formatTimestampDate(t, FULL_DATE_OPTIONS),
        requests: channel.requestCount,
        tokens,
        spendUsd: estimateSpend(tokens),
      });
    }
  }

  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const windowStart = todayStart - (days - 1) * DAY_MS;
  const buckets: DayBucket[] = [];
  for (let t = windowStart; t <= todayStart; t += DAY_MS) {
    buckets.push(
      map.get(t) ?? {
        t,
        fullDate: formatTimestampDate(t, FULL_DATE_OPTIONS),
        requests: 0,
        tokens: 0,
        spendUsd: 0,
      },
    );
  }
  return buckets;
}

function estimateSpend(tokens: number): number {
  return (tokens / 1_000_000) * 3;
}

export function UsageChart({ channels, days = 14 }: UsageChartProps) {
  const buckets = useMemo(() => bucketByDay(channels, days), [channels, days]);
  const maxRequests = useMemo(() => Math.max(1, ...buckets.map((bucket) => bucket.requests)), [buckets]);
  const totals = useMemo(() => {
    const requests = buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
    const tokens = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
    const spendUsd = buckets.reduce((sum, bucket) => sum + bucket.spendUsd, 0);
    return { requests, tokens, spendUsd };
  }, [buckets]);

  if (totals.requests === 0) {
    return (
      <div className="usage-chart usage-chart--empty">
        <div className="usage-chart-empty-text">
          No usage yet — start sending requests to see your activity here.
        </div>
      </div>
    );
  }

  return (
    <div className="usage-chart">
      <div className="usage-chart-totbar">
        <div className="usage-chart-tot">
          Requests
          <b>{formatNumber(totals.requests)}</b>
        </div>
        <div className="usage-chart-tot">
          Tokens
          <b>{formatCompact(totals.tokens)}</b>
        </div>
        <div className="usage-chart-tot">
          Spent
          <b>${formatUsd(totals.spendUsd)}</b>
        </div>
      </div>

      <div className="portal-spark" role="img" aria-label={`${days}-day usage chart`}>
        {buckets.map((bucket) => {
          const heightPct = bucket.requests === 0 ? 4 : Math.max(4, (bucket.requests / maxRequests) * 100);
          return (
            <div key={bucket.t} className="portal-spark-col">
              <div
                className="portal-spark-bar"
                style={{ height: `${heightPct}%` }}
              />
              <div className="portal-spark-tip" role="tooltip">
                <b>{bucket.fullDate}</b>
                <br />
                Requests <span className="acc">{formatNumber(bucket.requests)}</span>
                <br />
                Tokens <span className="acc">{formatCompact(bucket.tokens)}</span>
                <br />
                Spent <span className="acc">${formatUsd(bucket.spendUsd)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
