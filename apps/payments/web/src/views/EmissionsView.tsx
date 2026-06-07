import { useState, useEffect, useCallback } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useAccount } from 'wagmi';
import { parseAbi, formatUnits } from 'viem';
import type { PaymentConfig } from '../types';
import {
  getEmissionsInfo,
  getEmissionsPending,
  getEmissionsShares,
  getTransfersEnabled,
  type EmissionsEpochInfo,
  type EmissionsEpochParams,
  type EmissionsPendingResponse,
  type EmissionsShares as SharesType,
} from '../api';
import { EMISSIONS_CLAIM_ABI } from '../emissions-abi';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';

interface EmissionsViewProps {
  config: PaymentConfig | null;
}

const ANTS_DECIMALS = 18;

function safeBigint(s: string): bigint {
  try { return BigInt(s); } catch { return 0n; }
}

function addWei(a: string, b: string): string {
  try { return (BigInt(a) + BigInt(b)).toString(); } catch { return '0'; }
}

function formatAnts(amountWei: string): string {
  try {
    const n = parseFloat(formatUnits(BigInt(amountWei), ANTS_DECIMALS));
    if (n === 0) return '0';
    if (n < 0.0001) return '< 0.0001';
    return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  } catch {
    return '0';
  }
}

function getEffectiveParams(
  row: EmissionsPendingResponse['rows'][number] | undefined,
  fallback: SharesType | null | undefined,
): EmissionsEpochParams | null {
  if (row?.params?.initialized) return row.params;
  return fallback ?? row?.params ?? null;
}

function estimateSideReward(
  epochEmission: string,
  sharePct: number,
  maxSharePct: number,
  userPts: string,
  totalPts: string,
): bigint {
  const emission = safeBigint(epochEmission);
  const user = safeBigint(userPts);
  const total = safeBigint(totalPts);
  if (emission === 0n || total === 0n || user === 0n) return 0n;

  const bucket = emission * BigInt(Math.round(sharePct * 100)) / 10000n;
  const reward = bucket * user / total;
  const maxReward = bucket * BigInt(Math.round(maxSharePct * 100)) / 10000n;
  return reward > maxReward ? maxReward : reward;
}

function estimateRowReward(
  row: EmissionsPendingResponse['rows'][number],
  fallback: SharesType | null | undefined,
): string {
  const params = getEffectiveParams(row, fallback);
  if (!params) return '0';

  const sellerReward = estimateSideReward(
    row.epochEmission,
    params.sellerSharePct,
    params.maxSellerSharePct,
    row.seller.userPoints,
    row.seller.totalPoints,
  );
  const buyerReward = estimateSideReward(
    row.epochEmission,
    params.buyerSharePct,
    params.maxBuyerSharePct,
    row.buyer.userPoints,
    row.buyer.totalPoints,
  );
  return (sellerReward + buyerReward).toString();
}

function computeEpochShare(
  row: EmissionsPendingResponse['rows'][number] | undefined,
  fallback: SharesType | null | undefined,
): number {
  if (!row) return 0;
  const emission = safeBigint(row.epochEmission);
  if (emission === 0n) return 0;

  const reward = safeBigint(estimateRowReward(row, fallback));
  return Number((reward * 10000n) / emission) / 100;
}

function getSettledRowReward(
  row: EmissionsPendingResponse['rows'][number],
  fallback: SharesType | null | undefined,
): string {
  const params = getEffectiveParams(row, fallback);
  if (!params) return addWei(row.seller.amount, row.buyer.amount);
  const sellerReward = row.seller.claimed
    ? estimateSideReward(
      row.epochEmission,
      params.sellerSharePct,
      params.maxSellerSharePct,
      row.seller.userPoints,
      row.seller.totalPoints,
    ).toString()
    : row.seller.amount;
  const buyerReward = row.buyer.claimed
    ? estimateSideReward(
      row.epochEmission,
      params.buyerSharePct,
      params.maxBuyerSharePct,
      row.buyer.userPoints,
      row.buyer.totalPoints,
    ).toString()
    : row.buyer.amount;
  return addWei(sellerReward, buyerReward);
}

function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return 'ending now';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function EmissionsView({ config }: EmissionsViewProps) {
  const [info, setInfo] = useState<EmissionsEpochInfo | null>(null);
  const [pending, setPending] = useState<EmissionsPendingResponse | null>(null);
  const [shares, setShares] = useState<SharesType | null>(null);
  const [transfersEnabled, setTransfersEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const buyerAddress = config?.evmAddress ?? null;
  const { expectedChainId, ensureCorrectNetwork } = usePaymentNetwork(config);
  const { requireAuthorization } = useAuthorizedWallet();
  const { connector } = useAccount();

  const load = useCallback(async () => {
    if (!buyerAddress) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [infoRes, pendingRes, sharesRes, teRes] = await Promise.all([
        getEmissionsInfo().catch(() => null),
        getEmissionsPending(buyerAddress).catch(() => null),
        getEmissionsShares().catch(() => null),
        getTransfersEnabled().catch(() => ({ enabled: false, configured: false })),
      ]);
      setInfo(infoRes);
      setPending(pendingRes);
      setShares(sharesRes);
      setTransfersEnabled(teRes.enabled);
      if (!infoRes) setLoadError('Emissions not available on this chain');
    } finally {
      setLoading(false);
    }
  }, [buyerAddress]);

  useEffect(() => { void load(); }, [load]);

  // Seller claim — wagmi write
  const {
    writeContract: writeSellerClaim,
    data: sellerClaimTx,
    reset: resetSellerClaim,
  } = useWriteContract();
  const { isSuccess: sellerClaimConfirmed } = useWaitForTransactionReceipt({
    hash: sellerClaimTx,
    chainId: expectedChainId,
  });
  const [sellerClaimError, setSellerClaimError] = useState<string | null>(null);

  const handleClaimSeller = useCallback(() => {
    if (!config?.emissionsContractAddress || !pending) return;
    const epochs = pending.rows
      .filter((r) => !r.isCurrent && !r.seller.claimed && r.seller.amount !== '0')
      .map((r) => BigInt(r.epoch));
    if (epochs.length === 0) return;
    requireAuthorization(async () => {
      setSellerClaimError(null);
      try {
        await ensureCorrectNetwork();
        writeSellerClaim({
          address: config.emissionsContractAddress as `0x${string}`,
          abi: parseAbi(EMISSIONS_CLAIM_ABI),
          functionName: 'claimSellerEmissions',
          chainId: expectedChainId,
          args: [epochs],
        }, {
          onError: (err) => setSellerClaimError(getErrorMessage(err)),
        });
      } catch (err) {
        setSellerClaimError(getErrorMessage(err));
      }
    });
  }, [config, pending, ensureCorrectNetwork, expectedChainId, writeSellerClaim, requireAuthorization]);

  useEffect(() => {
    if (sellerClaimConfirmed) {
      resetSellerClaim();
      void load();
    }
  }, [sellerClaimConfirmed, resetSellerClaim, load]);

  // Buyer claim — wagmi write
  const {
    writeContract: writeBuyerClaim,
    data: buyerClaimTx,
    reset: resetBuyerClaim,
  } = useWriteContract();
  const { isSuccess: buyerClaimConfirmed } = useWaitForTransactionReceipt({
    hash: buyerClaimTx,
    chainId: expectedChainId,
  });
  const [buyerClaimError, setBuyerClaimError] = useState<string | null>(null);

  const handleClaimBuyer = useCallback(() => {
    if (!config?.emissionsContractAddress || !pending || !buyerAddress) return;
    const epochs = pending.rows
      .filter((r) => !r.isCurrent && !r.buyer.claimed && r.buyer.amount !== '0')
      .map((r) => BigInt(r.epoch));
    if (epochs.length === 0) return;
    requireAuthorization(async () => {
      setBuyerClaimError(null);
      try {
        await ensureCorrectNetwork();
        writeBuyerClaim({
          address: config.emissionsContractAddress as `0x${string}`,
          abi: parseAbi(EMISSIONS_CLAIM_ABI),
          functionName: 'claimBuyerEmissions',
          chainId: expectedChainId,
          args: [buyerAddress as `0x${string}`, epochs],
        }, {
          onError: (err) => setBuyerClaimError(getErrorMessage(err)),
        });
      } catch (err) {
        setBuyerClaimError(getErrorMessage(err));
      }
    });
  }, [config, pending, buyerAddress, ensureCorrectNetwork, expectedChainId, writeBuyerClaim, requireAuthorization]);

  useEffect(() => {
    if (buyerClaimConfirmed) {
      resetBuyerClaim();
      void load();
    }
  }, [buyerClaimConfirmed, resetBuyerClaim, load]);

  if (loading && !info) {
    return <div className="rewards-view"><div className="overview-empty-desc">Loading…</div></div>;
  }

  if (loadError || !info) {
    return (
      <div className="rewards-view">
        <div className="overview-empty">
          <div className="overview-empty-title">Emissions not available</div>
          <div className="overview-empty-desc">{loadError ?? 'The Emissions contract is not configured for this chain.'}</div>
        </div>
      </div>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const epochStart = info.genesis + info.currentEpoch * info.epochDuration;
  const epochEnd = epochStart + info.epochDuration;
  const timeRemaining = epochEnd - now;
  const epochsUntilHalving = info.halvingInterval - (info.currentEpoch % info.halvingInterval);

  const rows = pending?.rows ?? [];
  const pastRows = rows.filter((r) => !r.isCurrent);
  const currentRow = rows.find((r) => r.isCurrent);
  const currentParams = getEffectiveParams(currentRow, shares);
  const currentEstimate = currentRow ? estimateRowReward(currentRow, shares) : '0';
  const epochSharePct = computeEpochShare(currentRow, shares);

  let totalClaimable = 0n;
  let totalClaimed = 0n;
  for (const r of pastRows) {
    const params = getEffectiveParams(r, shares);
    if (r.seller.claimed && params) {
      totalClaimed += estimateSideReward(
        r.epochEmission,
        params.sellerSharePct,
        params.maxSellerSharePct,
        r.seller.userPoints,
        r.seller.totalPoints,
      );
    } else {
      totalClaimable += safeBigint(r.seller.amount);
    }
    if (r.buyer.claimed && params) {
      totalClaimed += estimateSideReward(
        r.epochEmission,
        params.buyerSharePct,
        params.maxBuyerSharePct,
        r.buyer.userPoints,
        r.buyer.totalPoints,
      );
    } else {
      totalClaimable += safeBigint(r.buyer.amount);
    }
  }
  const totalEarned = safeBigint(currentEstimate) + totalClaimable + totalClaimed;

  const chartRows = pastRows
    .slice()
    .sort((a, b) => Number(a.epoch) - Number(b.epoch))
    .slice(-6);
  const rewardBars = [
    ...chartRows.map((row) => ({
      key: String(row.epoch),
      label: String(row.epoch),
      amount: getSettledRowReward(row, shares),
      isCurrent: false,
    })),
    ...(currentRow ? [{
      key: 'current',
      label: `${currentRow.epoch}·now`,
      amount: currentEstimate,
      isCurrent: true,
    }] : []),
  ];
  const maxReward = rewardBars.reduce((max, bar) => {
    const amount = safeBigint(bar.amount);
    return amount > max ? amount : max;
  }, 0n);

  return (
    <div className="rewards-view">
      <section className="rewards-claim-row">
        <div>
          <div className="portal-kicker">Claimable now</div>
          <div className="rewards-claim-value">
            {formatAnts(totalClaimable.toString())}
            <span>$ANTS</span>
          </div>
          <p>From closed epochs</p>
        </div>
        <div className="rewards-claim-actions">
          <button
            type="button"
            className="portal-primary-btn"
            disabled={!pending || pending.rows.every((r) => r.isCurrent || r.seller.claimed || r.seller.amount === '0')}
            onClick={handleClaimSeller}
          >
            Claim seller
          </button>
          <button
            type="button"
            className="portal-primary-btn"
            disabled={!pending || pending.rows.every((r) => r.isCurrent || r.buyer.claimed || r.buyer.amount === '0')}
            onClick={handleClaimBuyer}
          >
            Claim buyer
          </button>
          {config?.antsTokenAddress && connector && (
            <button
              type="button"
              className="portal-secondary-btn"
              onClick={async () => {
                try {
                  const provider = await connector.getProvider();
                  await (provider as { request: (args: unknown) => Promise<unknown> }).request({
                    method: 'wallet_watchAsset',
                    params: {
                      type: 'ERC20',
                      options: {
                        address: config.antsTokenAddress,
                        symbol: 'ANTS',
                        decimals: 18,
                      },
                    },
                  });
                } catch {
                  // user rejected or wallet doesn't support watchAsset
                }
              }}
            >
              Add ANTS to wallet
            </button>
          )}
        </div>
      </section>

      <section className="portal-content-section" aria-labelledby="emissions-current-title">
        <div className="portal-content-head">
          <h2 className="portal-content-title" id="emissions-current-title">Epoch #{info.currentEpoch}</h2>
          {currentParams && (
            <p>
              Split: {currentParams.sellerSharePct}% sellers · {currentParams.buyerSharePct}% buyers ·{' '}
              {currentParams.reserveSharePct}% reserve · {currentParams.teamSharePct}% team
            </p>
          )}
        </div>

        <div className="portal-metrics-grid" aria-label="Current epoch and position details">
          <div className="portal-metric">
            <div className="portal-kicker">Ends in</div>
            <strong>{formatTimeRemaining(timeRemaining)}</strong>
          </div>
          <div className="portal-metric">
            <div className="portal-kicker">Epoch pool</div>
            <strong>{formatAnts(info.epochEmission)}</strong>
          </div>
          <div className="portal-metric">
            <div className="portal-kicker">Epoch duration</div>
            <strong>{Math.round(info.epochDuration / 86400)}d</strong>
          </div>
          <div className="portal-metric">
            <div className="portal-kicker">Next halving</div>
            <strong>{epochsUntilHalving}</strong>
          </div>
          <div className="portal-metric">
            <div className="portal-kicker">Estimated reward</div>
            <strong>~{formatAnts(currentEstimate)}</strong>
          </div>
          <div className="portal-metric">
            <div className="portal-kicker">Your epoch share</div>
            <strong>{epochSharePct > 0 ? `${epochSharePct.toFixed(2)}%` : '—'}</strong>
          </div>
          <div className="portal-metric">
            <div className="portal-kicker">Claimable</div>
            <strong>{formatAnts(totalClaimable.toString())}</strong>
          </div>
          <div className="portal-metric">
            <div className="portal-kicker">Already claimed</div>
            <strong>{formatAnts(totalClaimed.toString())}</strong>
          </div>
        </div>
      </section>

      <section className="portal-content-section" aria-labelledby="emissions-about-title">
        <div className="portal-content-head">
          <h2 className="portal-content-title" id="emissions-about-title">About $ANTS</h2>
        </div>
        <div className="rewards-info">
          <p>
            $ANTS is the native token of the AntSeed network. It is minted
            each epoch to active sellers and buyers in proportion to their
            on-chain activity. There is no pre-mining — you earn
            simply by using the network.
          </p>
          <p>
            Claims are non-custodial: seller claims mint to the claiming wallet,
            and buyer claims mint to the wallet you&apos;ve authorized for your
            buyer identity.
          </p>
        </div>
      </section>

      <section className="portal-content-section" aria-labelledby="emissions-history-title">
        <div className="portal-content-head">
          <h2 className="portal-content-title" id="emissions-history-title">Emission history</h2>
          <p>Current epoch is an estimate that updates after each on-chain settlement.</p>
        </div>

        <div className="rewards-growth">
          <div className="rewards-growth-head">
            <div className="portal-kicker">Reward growth · per epoch</div>
            <p>Total earned to date <strong>{formatAnts(totalEarned.toString())} $ANTS</strong></p>
          </div>
          <div className="rewards-bars" aria-hidden="true">
            {rewardBars.map((bar) => {
              const amount = safeBigint(bar.amount);
              const heightPct = maxReward > 0n ? Number((amount * 100n) / maxReward) : 0;
              return (
                <div className="rewards-bar-col" key={bar.key}>
                  <span
                    className={bar.isCurrent ? 'rewards-bars-current' : undefined}
                    style={{ height: `${Math.max(heightPct, amount > 0n ? 5 : 2)}%` }}
                  />
                  <em>{bar.label}</em>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rewards-history">
          <div className="portal-kicker">Epoch history</div>
          {pastRows.length === 0 ? (
            <p>No closed epochs yet.</p>
          ) : (
            pastRows.slice().reverse().map((row) => (
              <div className="rewards-history-row" key={row.epoch}>
                <span>Epoch {row.epoch}</span>
                <strong>{formatAnts(getSettledRowReward(row, shares))} $ANTS</strong>
              </div>
            ))
          )}
        </div>
      </section>

      {(sellerClaimError || buyerClaimError) && (
        <div className="status-msg status-error">{sellerClaimError || buyerClaimError}</div>
      )}
      {transfersEnabled === false && (
        <div className="portal-inline-warning">
          <span aria-hidden="true" />
          ANTS transfers are not enabled yet. Claimed tokens remain in your wallet until governance enables transfers.
        </div>
      )}
    </div>
  );
}
