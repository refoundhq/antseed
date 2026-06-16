import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import type { PaymentConfig } from '../types';
import { DIEM_STAKING_PROXY_ADDRESS } from '../diem-proxy-abi';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import { ConnectWalletAction } from '../components/ConnectWalletAction';
import {
  DIEM_PROXY_ABI,
  formatDiemEpochRange,
  getDiemClaimableEpochs,
  getDiemPendingTotal,
  loadDiemRewardSnapshot,
  type DiemRewardRow,
  type DiemRewardSnapshot,
} from '../utils/diemRewards';
import { formatAntsAmount } from '../utils/format';

interface DiemRewardsViewProps {
  config: PaymentConfig | null;
}

export function DiemRewardsView({ config }: DiemRewardsViewProps) {
  return (
    <div className="rewards-view">
      <DiemRewardsSection config={config} />
    </div>
  );
}

function DiemRewardsSection({ config }: DiemRewardsViewProps) {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const accountAddress = address ?? null;
  const { expectedChainId, ensureCorrectNetwork } = usePaymentNetwork(config);
  const [snapshot, setSnapshot] = useState<DiemRewardSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimSuccess, setClaimSuccess] = useState(false);

  const {
    writeContract,
    data: claimTx,
    reset: resetClaim,
    isPending: claimSubmitting,
  } = useWriteContract();
  const { isSuccess: claimConfirmed } = useWaitForTransactionReceipt({
    hash: claimTx,
    chainId: expectedChainId,
  });

  const load = useCallback(async () => {
    if (!isConnected || !accountAddress || !publicClient) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const nextSnapshot = await loadDiemRewardSnapshot(publicClient, accountAddress as `0x${string}`);
      setSnapshot(nextSnapshot);
    } catch (err) {
      setLoadError(getErrorMessage(err, 'Unable to load DIEM rewards.'));
    } finally {
      setLoading(false);
    }
  }, [accountAddress, isConnected, publicClient]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!claimConfirmed) return;
    setClaimSuccess(true);
    resetClaim();
    void load();
  }, [claimConfirmed, load, resetClaim]);

  const claimableEpochs = useMemo(() => getDiemClaimableEpochs(snapshot), [snapshot]);
  const totalPending = useMemo(() => getDiemPendingTotal(snapshot), [snapshot]);

  const handleClaim = useCallback(() => {
    if (!snapshot || claimableEpochs.length === 0) return;
    setClaimError(null);
    setClaimSuccess(false);
    void (async () => {
      try {
        await ensureCorrectNetwork();
        writeContract({
          address: DIEM_STAKING_PROXY_ADDRESS,
          abi: DIEM_PROXY_ABI,
          functionName: 'claimAnts',
          chainId: expectedChainId,
          args: [claimableEpochs],
        }, {
          onError: (err) => setClaimError(getErrorMessage(err)),
        });
      } catch (err) {
        setClaimError(getErrorMessage(err));
      }
    })();
  }, [claimableEpochs, ensureCorrectNetwork, expectedChainId, snapshot, writeContract]);

  return (
    <>
      <section className="portal-content-section portal-content-section--diem">
        <div className="portal-content-head portal-content-head--row">
          <div>
            <div className="portal-kicker">DIEM staking</div>
            <h2 className="portal-content-title">Your DIEM $ANTS</h2>
            <p>
              Rewards earned from staking DIEM through the AntSeed proxy. The 10% DIEM pool fee flows
              to the Protocol Reserve to strengthen the AntSeed ecosystem and ANTS. Connect the same
              wallet you used for staking.
            </p>
          </div>
          {!isConnected || !accountAddress ? (
            <ConnectWalletAction className="portal-primary-btn" />
          ) : null}
        </div>
      </section>

      {!isConnected || !accountAddress ? null : loading && !snapshot ? (
        <div className="activity-empty">Loading DIEM rewards…</div>
      ) : loadError ? (
        <div className="portal-inline-warning">
          <span aria-hidden="true" />
          {loadError}
        </div>
      ) : (
        <>
          <section className="portal-content-section" aria-labelledby="diem-summary-title">
            <div className="portal-content-head">
              <h2 className="portal-content-title" id="diem-summary-title">Reward summary</h2>
            </div>

            <div className="portal-metrics-grid">
              <div className="portal-metric">
                <div className="portal-kicker">Pending $ANTS</div>
                <strong>{formatAntsAmount(totalPending)} $ANTS</strong>
                <p>Across scanned finalized epochs</p>
              </div>
              <div className="portal-metric">
                <div className="portal-kicker">Claimable epochs</div>
                <strong>{claimableEpochs.length}</strong>
                <p>Includes 0-$ANTS epochs to clear cursor</p>
              </div>
              <div className="portal-metric">
                <div className="portal-kicker">Finalized epoch</div>
                <strong>#{snapshot?.finalizedRewardEpoch ?? '—'}</strong>
                <p>Last claimable reward epoch boundary</p>
              </div>
              <div className="portal-metric">
                <div className="portal-kicker">Scanned range</div>
                <strong>{snapshot ? formatDiemEpochRange(snapshot) : '—'}</strong>
                <p>{snapshot?.hasMore ? 'More epochs available after claim' : 'Up to date'}</p>
              </div>
            </div>

            <div className="rewards-diem-actions">
              <button
                type="button"
                className="portal-primary-btn"
                onClick={handleClaim}
                disabled={claimSubmitting || claimableEpochs.length === 0}
              >
                {claimSubmitting
                  ? 'Claiming…'
                  : totalPending > 0n
                    ? `Claim ${formatAntsAmount(totalPending)} $ANTS`
                    : claimableEpochs.length > 0
                      ? 'Clear 0-$ANTS epochs'
                      : 'Nothing to claim'}
              </button>
              {snapshot?.hasMore && <span>More finalized epochs load after claiming this range.</span>}
            </div>
          </section>

          <section className="portal-content-section" aria-labelledby="diem-history-title">
            <div className="portal-content-head">
              <h2 className="portal-content-title" id="diem-history-title">Diem proxy epochs</h2>
              <p>Claimable epochs are finalized by the DiemStakingProxy. Current epochs appear after the proxy closes them.</p>
            </div>

            <DiemRewardsList rows={snapshot?.rows ?? []} />

            {(claimError || claimSuccess) && (
              <div className={`status-msg ${claimError ? 'status-error' : 'status-success'}`}>
                {claimError ?? 'DIEM $ANTS claim confirmed.'}
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

function DiemRewardsList({ rows }: { rows: DiemRewardRow[] }) {
  if (rows.length === 0) {
    return <p>No finalized DIEM proxy epochs to show.</p>;
  }
  return (
    <div className="rewards-history rewards-history--nested">
      <div className="portal-kicker">DIEM epochs</div>
      {rows.slice().reverse().map((row) => {
        const statusLabel = row.claimed ? 'Claimed' : row.amount > 0n ? 'Claimable' : 'Clearable';
        return (
          <div className="rewards-history-row" key={row.epoch}>
            <span>Epoch {row.epoch}</span>
            <strong>{formatAntsAmount(row.amount)} $ANTS</strong>
            <em>{statusLabel}</em>
          </div>
        );
      })}
    </div>
  );
}
