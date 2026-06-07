import { parseAbi } from 'viem';
import { DIEM_STAKING_PROXY_ABI, DIEM_STAKING_PROXY_ADDRESS } from '../diem-proxy-abi';
import { formatAntsAmount } from './format';

export interface DiemRewardRow {
  epoch: number;
  amount: bigint;
  claimed: boolean;
}

export interface DiemRewardSnapshot {
  firstRewardEpoch: number;
  finalizedRewardEpoch: number;
  syncedRewardEpoch: number;
  userLastClaimedEpoch: number;
  rows: DiemRewardRow[];
  hasMore: boolean;
}

interface MulticallClient {
  multicall(args: {
    allowFailure: true;
    contracts: readonly unknown[];
  }): Promise<readonly { result?: unknown }[]>;
}

const MAX_EPOCHS_PREVIEW = 16;

export const DIEM_PROXY_ABI = parseAbi(DIEM_STAKING_PROXY_ABI);
export { formatAntsAmount };

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function asBigint(value: unknown): bigint {
  return typeof value === 'bigint' ? value : 0n;
}

export function formatDiemEpochRange(snapshot: DiemRewardSnapshot): string {
  if (snapshot.rows.length === 0) return 'No finalized epochs';
  const first = snapshot.rows[0]?.epoch;
  const last = snapshot.rows[snapshot.rows.length - 1]?.epoch;
  return first === last ? `Epoch ${first}` : `Epochs ${first}-${last}`;
}

export function getDiemClaimableEpochs(snapshot: DiemRewardSnapshot | null): number[] {
  return snapshot?.rows.filter((row) => !row.claimed).map((row) => row.epoch) ?? [];
}

export function getDiemPendingTotal(snapshot: DiemRewardSnapshot | null): bigint {
  return snapshot?.rows.reduce((sum, row) => sum + (row.claimed ? 0n : row.amount), 0n) ?? 0n;
}

export async function loadDiemRewardSnapshot(
  publicClient: MulticallClient,
  accountAddress: `0x${string}`,
): Promise<DiemRewardSnapshot> {
  const [
    firstRewardEpochRaw,
    finalizedRewardEpochRaw,
    syncedRewardEpochRaw,
    userLastClaimedEpochRaw,
  ] = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_PROXY_ABI, functionName: 'firstRewardEpoch' },
      { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_PROXY_ABI, functionName: 'finalizedRewardEpoch' },
      { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_PROXY_ABI, functionName: 'syncedRewardEpoch' },
      { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_PROXY_ABI, functionName: 'userLastClaimedEpoch', args: [accountAddress] },
    ],
  });

  const firstRewardEpoch = asNumber(firstRewardEpochRaw?.result);
  const finalizedRewardEpoch = asNumber(finalizedRewardEpochRaw?.result);
  const syncedRewardEpoch = asNumber(syncedRewardEpochRaw?.result);
  const userLastClaimedEpoch = asNumber(userLastClaimedEpochRaw?.result);
  const from = Math.max(userLastClaimedEpoch, firstRewardEpoch);
  const to = Math.min(finalizedRewardEpoch, from + MAX_EPOCHS_PREVIEW);
  const epochs: number[] = [];
  for (let epoch = from; epoch < to; epoch += 1) epochs.push(epoch);

  const rows = epochs.length === 0
    ? []
    : await publicClient.multicall({
      allowFailure: true,
      contracts: epochs.flatMap((epoch) => [
        {
          address: DIEM_STAKING_PROXY_ADDRESS,
          abi: DIEM_PROXY_ABI,
          functionName: 'pendingAntsForEpoch',
          args: [accountAddress, epoch] as const,
        },
        {
          address: DIEM_STAKING_PROXY_ADDRESS,
          abi: DIEM_PROXY_ABI,
          functionName: 'userEpochClaimed',
          args: [accountAddress, epoch] as const,
        },
      ]),
    });

  return {
    firstRewardEpoch,
    finalizedRewardEpoch,
    syncedRewardEpoch,
    userLastClaimedEpoch,
    rows: epochs.map((epoch, i) => ({
      epoch,
      amount: asBigint(rows[i * 2]?.result),
      claimed: rows[i * 2 + 1]?.result === true,
    })),
    hasMore: from + MAX_EPOCHS_PREVIEW < finalizedRewardEpoch,
  };
}
