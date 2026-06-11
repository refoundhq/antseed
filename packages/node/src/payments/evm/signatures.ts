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

/**
 * SpendingAuth metadata v2.
 *
 * ABI layout:
 *   abi.encode(
 *     uint256 version,
 *     uint256 cumulativeInputTokens,
 *     uint256 cumulativeOutputTokens,
 *     uint256 cumulativeRequestCount,
 *     ServiceTotal[] services
 *   )
 *
 * The first four fields intentionally match v1 so legacy decoders can read
 * aggregate token/request counters by decoding only those fields. Service
 * entries are buyer-side attribution metadata for indexers: input tokens
 * include cached input, with cached input broken out separately.
 *
 * Service cumulativeAmount values may be lower than the top-level
 * cumulativeAmount because the buyer can sign reserve headroom, cap a
 * per-request amount, or extend auth without attributing that delta to a
 * specific service.
 */

export interface SpendingAuthMetadata {
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  services?: SpendingAuthServiceMetadata[];
}

export interface SpendingAuthServiceMetadata {
  serviceId: string;
  cumulativeAmount: bigint;
  cumulativeInputTokens: bigint;
  cumulativeCachedInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
}

export const METADATA_VERSION = 2n;

const SERVICE_METADATA_ABI_TYPE =
  'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount)[]';

export function encodeMetadata(metadata: SpendingAuthMetadata): string {
  const coder = AbiCoder.defaultAbiCoder();
  const services = [...(metadata.services ?? [])].sort((a, b) =>
    a.serviceId.toLowerCase().localeCompare(b.serviceId.toLowerCase()),
  );
  return coder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256', SERVICE_METADATA_ABI_TYPE],
    [
      METADATA_VERSION,
      metadata.cumulativeInputTokens,
      metadata.cumulativeOutputTokens,
      metadata.cumulativeRequestCount,
      services,
    ],
  );
}

export function getServiceMetadataId(service: string): string {
  return id(service.trim());
}

export function computeMetadataHash(metadata: SpendingAuthMetadata): string {
  return keccak256(encodeMetadata(metadata));
}

export const ZERO_METADATA: SpendingAuthMetadata = {
  cumulativeInputTokens: 0n,
  cumulativeOutputTokens: 0n,
  cumulativeRequestCount: 0n,
  services: [],
};

export const ZERO_METADATA_HASH: string = computeMetadataHash(ZERO_METADATA);

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
