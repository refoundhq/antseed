import { type AbstractSigner, type TypedDataDomain, AbiCoder, id, keccak256 } from 'ethers';

// =========================================================================
// EIP-712 Types — AntSeed SpendingAuth (cumulative payment authorization)
// =========================================================================

export const SPENDING_AUTH_TYPES = {
  SpendingAuth: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
    { name: 'metadataHash', type: 'bytes32' },
  ],
};

export const RESERVE_AUTH_TYPES = {
  ReserveAuth: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'maxAmount', type: 'uint128' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export const SET_OPERATOR_TYPES = {
  SetOperator: [
    { name: 'operator', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};

// =========================================================================
// Message interfaces
// =========================================================================

export interface SpendingAuthMessage {
  channelId: string;
  cumulativeAmount: bigint;
  metadataHash: string; // bytes32 hex
}

export interface ReserveAuthMessage {
  channelId: string;
  maxAmount: bigint;
  deadline: bigint;
}

export interface SetOperatorMessage {
  operator: string;
  nonce: bigint;
}

// =========================================================================
// Metadata encoding
// =========================================================================

export type Uintish = bigint | number | string;

export interface SpendingAuthMetadata {
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
}

export interface SpendingAuthMetadataV2 {
  catalogRoot: string;
  usageByServiceRoot: string;
  receiptRoot: string;
  cumulativeFreshInputTokens: bigint;
  cumulativeCachedInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  cumulativeAmountPaid: bigint;
}

export type DecodedSpendingAuthMetadata =
  | ({ version: 1n } & SpendingAuthMetadata)
  | ({ version: 2n } & SpendingAuthMetadataV2);

export interface ServiceCatalogLeaf {
  sellerAgentId: Uintish;
  sellerAddress: string;
  serviceIdHash: string;
  tokenizerIdHash: string;
  inputUsdPerMillion: Uintish;
  cachedInputUsdPerMillion: Uintish;
  outputUsdPerMillion: Uintish;
  serviceMode: Uintish;
  termsHash: string;
  validFrom: Uintish;
  validUntil: Uintish;
}

export interface ServiceUsageLeaf {
  channelId: string;
  serviceIdHash: string;
  catalogLeafHash: string;
  serviceMode: Uintish;
  cumulativeFreshInputTokens: Uintish;
  cumulativeCachedInputTokens: Uintish;
  cumulativeOutputTokens: Uintish;
  cumulativeRequestCount: Uintish;
  cumulativeAmountPaid: Uintish;
}

export interface ReceiptLeaf {
  channelId: string;
  requestIndex: Uintish;
  requestIdHash: string;
  requestHash: string;
  responseHash: string;
  serviceIdHash: string;
  catalogLeafHash: string;
  freshInputTokens: Uintish;
  cachedInputTokens: Uintish;
  outputTokens: Uintish;
  costUsdc: Uintish;
  cumulativeAmountAfterRequest: Uintish;
}

export const METADATA_V1_VERSION = 1n;
export const METADATA_V2_VERSION = 2n;
export const METADATA_VERSION = METADATA_V1_VERSION;
export const SERVICE_MODE_FREE = 0n;
export const SERVICE_MODE_PAID = 1n;
export const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;

export function encodeMetadata(metadata: SpendingAuthMetadata): string {
  const coder = AbiCoder.defaultAbiCoder();
  return coder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256'],
    [METADATA_V1_VERSION, metadata.cumulativeInputTokens, metadata.cumulativeOutputTokens, metadata.cumulativeRequestCount],
  );
}

export function encodeMetadataV2(metadata: SpendingAuthMetadataV2): string {
  const coder = AbiCoder.defaultAbiCoder();
  return coder.encode(
    ['uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
    [
      METADATA_V2_VERSION,
      metadata.catalogRoot,
      metadata.usageByServiceRoot,
      metadata.receiptRoot,
      metadata.cumulativeFreshInputTokens,
      metadata.cumulativeCachedInputTokens,
      metadata.cumulativeOutputTokens,
      metadata.cumulativeRequestCount,
      metadata.cumulativeAmountPaid,
    ],
  );
}

export function computeMetadataHash(metadata: SpendingAuthMetadata | SpendingAuthMetadataV2): string {
  if ('catalogRoot' in metadata) {
    return computeEncodedMetadataHash(encodeMetadataV2(metadata));
  }
  return keccak256(encodeMetadata(metadata));
}

export function computeEncodedMetadataHash(encodedMetadata: string): string {
  return keccak256(encodedMetadata);
}

export function decodeMetadata(encodedMetadata: string): DecodedSpendingAuthMetadata {
  const coder = AbiCoder.defaultAbiCoder();
  const [version] = coder.decode(['uint256'], encodedMetadata) as unknown as [bigint];
  if (version === METADATA_V2_VERSION) {
    const [
      ,
      catalogRoot,
      usageByServiceRoot,
      receiptRoot,
      cumulativeFreshInputTokens,
      cumulativeCachedInputTokens,
      cumulativeOutputTokens,
      cumulativeRequestCount,
      cumulativeAmountPaid,
    ] = coder.decode(
      ['uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      encodedMetadata,
    ) as unknown as [bigint, string, string, string, bigint, bigint, bigint, bigint, bigint];

    return {
      version: METADATA_V2_VERSION,
      catalogRoot,
      usageByServiceRoot,
      receiptRoot,
      cumulativeFreshInputTokens,
      cumulativeCachedInputTokens,
      cumulativeOutputTokens,
      cumulativeRequestCount,
      cumulativeAmountPaid,
    };
  }
  if (version === METADATA_V1_VERSION) {
    const [, cumulativeInputTokens, cumulativeOutputTokens, cumulativeRequestCount] = coder.decode(
      ['uint256', 'uint256', 'uint256', 'uint256'],
      encodedMetadata,
    ) as unknown as [bigint, bigint, bigint, bigint];
    return {
      version: METADATA_V1_VERSION,
      cumulativeInputTokens,
      cumulativeOutputTokens,
      cumulativeRequestCount,
    };
  }
  throw new Error(`Unsupported spending auth metadata version: ${version}`);
}

export function hashUtf8(value: string): string {
  return id(value);
}

export function hashServiceCatalogLeaf(leaf: ServiceCatalogLeaf): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(
    ['uint256', 'address', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint256', 'uint256'],
    [
      toBigInt(leaf.sellerAgentId),
      leaf.sellerAddress,
      leaf.serviceIdHash,
      leaf.tokenizerIdHash,
      toBigInt(leaf.inputUsdPerMillion),
      toBigInt(leaf.cachedInputUsdPerMillion),
      toBigInt(leaf.outputUsdPerMillion),
      toBigInt(leaf.serviceMode),
      leaf.termsHash,
      toBigInt(leaf.validFrom),
      toBigInt(leaf.validUntil),
    ],
  ));
}

export function hashServiceUsageLeaf(leaf: ServiceUsageLeaf): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(
    ['bytes32', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
    [
      leaf.channelId,
      leaf.serviceIdHash,
      leaf.catalogLeafHash,
      toBigInt(leaf.serviceMode),
      toBigInt(leaf.cumulativeFreshInputTokens),
      toBigInt(leaf.cumulativeCachedInputTokens),
      toBigInt(leaf.cumulativeOutputTokens),
      toBigInt(leaf.cumulativeRequestCount),
      toBigInt(leaf.cumulativeAmountPaid),
    ],
  ));
}

export function hashReceiptLeaf(leaf: ReceiptLeaf): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(
    ['bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
    [
      leaf.channelId,
      toBigInt(leaf.requestIndex),
      leaf.requestIdHash,
      leaf.requestHash,
      leaf.responseHash,
      leaf.serviceIdHash,
      leaf.catalogLeafHash,
      toBigInt(leaf.freshInputTokens),
      toBigInt(leaf.cachedInputTokens),
      toBigInt(leaf.outputTokens),
      toBigInt(leaf.costUsdc),
      toBigInt(leaf.cumulativeAmountAfterRequest),
    ],
  ));
}

export function computeMerkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) return ZERO_BYTES32;
  let level = [...leaves].sort(compareHex);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(hashMerklePair(left, right));
    }
    level = next;
  }
  return level[0]!;
}

export function computeMerkleProof(leaves: readonly string[], targetLeaf: string): string[] {
  if (leaves.length === 0) return [];
  let level = [...leaves].sort(compareHex);
  let index = level.findIndex((leaf) => leaf.toLowerCase() === targetLeaf.toLowerCase());
  if (index === -1) {
    throw new Error('Target leaf is not present in Merkle tree');
  }

  const proof: string[] = [];
  while (level.length > 1) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    proof.push(level[siblingIndex] ?? level[index]!);

    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(hashMerklePair(left, right));
    }
    index = Math.floor(index / 2);
    level = next;
  }
  return proof;
}

export function verifyMerkleProof(leaf: string, proof: readonly string[], expectedRoot: string): boolean {
  const root = proof.reduce((acc, sibling) => hashMerklePair(acc, sibling), leaf);
  return root.toLowerCase() === expectedRoot.toLowerCase();
}

export function sumServiceUsageLeaves(leaves: readonly ServiceUsageLeaf[]): Omit<SpendingAuthMetadataV2, 'catalogRoot' | 'usageByServiceRoot' | 'receiptRoot'> {
  return leaves.reduce(
    (acc, leaf) => ({
      cumulativeFreshInputTokens: acc.cumulativeFreshInputTokens + toBigInt(leaf.cumulativeFreshInputTokens),
      cumulativeCachedInputTokens: acc.cumulativeCachedInputTokens + toBigInt(leaf.cumulativeCachedInputTokens),
      cumulativeOutputTokens: acc.cumulativeOutputTokens + toBigInt(leaf.cumulativeOutputTokens),
      cumulativeRequestCount: acc.cumulativeRequestCount + toBigInt(leaf.cumulativeRequestCount),
      cumulativeAmountPaid: acc.cumulativeAmountPaid + toBigInt(leaf.cumulativeAmountPaid),
    }),
    {
      cumulativeFreshInputTokens: 0n,
      cumulativeCachedInputTokens: 0n,
      cumulativeOutputTokens: 0n,
      cumulativeRequestCount: 0n,
      cumulativeAmountPaid: 0n,
    },
  );
}

export function metadataV2MatchesServiceUsage(metadata: SpendingAuthMetadataV2, leaves: readonly ServiceUsageLeaf[]): boolean {
  const root = computeMerkleRoot(leaves.map(hashServiceUsageLeaf));
  const sums = sumServiceUsageLeaves(leaves);
  return root.toLowerCase() === metadata.usageByServiceRoot.toLowerCase()
    && sums.cumulativeFreshInputTokens === metadata.cumulativeFreshInputTokens
    && sums.cumulativeCachedInputTokens === metadata.cumulativeCachedInputTokens
    && sums.cumulativeOutputTokens === metadata.cumulativeOutputTokens
    && sums.cumulativeRequestCount === metadata.cumulativeRequestCount
    && sums.cumulativeAmountPaid === metadata.cumulativeAmountPaid;
}

export const ZERO_METADATA: SpendingAuthMetadata = {
  cumulativeInputTokens: 0n,
  cumulativeOutputTokens: 0n,
  cumulativeRequestCount: 0n,
};

export const ZERO_METADATA_HASH: string = computeMetadataHash(ZERO_METADATA);

function toBigInt(value: Uintish): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function compareHex(a: string, b: string): number {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

function hashMerklePair(a: string, b: string): string {
  const [left, right] = compareHex(a, b) <= 0 ? [a, b] : [b, a];
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(['bytes32', 'bytes32'], [left, right]));
}

// =========================================================================
// Channel ID computation (must match AntseedChannels.computeChannelId)
// =========================================================================

/**
 * Compute the deterministic channelId.
 * Must match: keccak256(abi.encode(buyer, seller, salt))
 */
export function computeChannelId(
  buyer: string,
  seller: string,
  salt: string,
): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(
    ['address', 'address', 'bytes32'],
    [buyer, seller, salt],
  ));
}

// =========================================================================
// EIP-712 Domain helpers
// =========================================================================

export function makeChannelsDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedChannels',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  };
}

export function makeDepositsDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedDeposits',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  };
}

// =========================================================================
// Signing functions — EIP-712 (on-chain)
// =========================================================================

export async function signSpendingAuth(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: SpendingAuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, SPENDING_AUTH_TYPES, msg);
}

export async function signReserveAuth(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: ReserveAuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, RESERVE_AUTH_TYPES, msg);
}

export async function signSetOperator(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: SetOperatorMessage,
): Promise<string> {
  return signer.signTypedData(domain, SET_OPERATOR_TYPES, msg);
}
