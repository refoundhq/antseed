import { ethers, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import type { ChannelReportAttestationPayload, ChannelUsageReportServiceUsageLeafPayload } from '../../types/protocol.js';

export interface StatsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export interface DecodedMetadataRecorded {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  agentId: bigint;
  buyer: string;
  channelId: string;   // 0x-prefixed hex, 32 bytes
  metadataHash: string; // 0x-prefixed hex, 32 bytes
  inputTokens: bigint;  // delta
  outputTokens: bigint; // delta
  requestCount: bigint; // delta
}

export interface DecodedUsageReportVerificationRecorded {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  reportHash: string;
  sellerAgentId: bigint;
  verifierAgentId: bigint;
  seller: string;
  buyer: string;
  verifier: string;
  channelId: string;
  metadataHash: string;
  catalogRoot: string;
  usageByServiceRoot: string;
  cumulativeAmount: bigint;
  accepted: boolean;
}

export interface DecodedUsageReportServiceUsageRecorded {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  reportHash: string;
  sellerAgentId: bigint;
  serviceIdHash: string;
  channelId: string;
  catalogLeafHash: string;
  serviceMode: bigint;
  cumulativeFreshInputTokens: bigint;
  cumulativeCachedInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  cumulativeAmountPaid: bigint;
}

const STATS_ABI = [
  'event MetadataRecorded(uint256 indexed agentId, address indexed buyer, bytes32 indexed channelId, bytes32 metadataHash, uint256 inputTokens, uint256 outputTokens, uint256 requestCount)',
  'event UsageReportVerificationRecorded(bytes32 indexed reportHash, uint256 indexed sellerAgentId, uint256 indexed verifierAgentId, address seller, address buyer, address verifier, bytes32 channelId, bytes32 metadataHash, bytes32 catalogRoot, bytes32 usageByServiceRoot, uint256 cumulativeAmount, bool accepted)',
  'event UsageReportServiceUsageRecorded(bytes32 indexed reportHash, uint256 indexed sellerAgentId, bytes32 indexed serviceIdHash, bytes32 channelId, bytes32 catalogLeafHash, uint256 serviceMode, uint256 cumulativeFreshInputTokens, uint256 cumulativeCachedInputTokens, uint256 cumulativeOutputTokens, uint256 cumulativeRequestCount, uint256 cumulativeAmountPaid)',
  'function recordUsageReportVerification(bytes32 reportHash, bytes32 channelId, address seller, address buyer, uint256 sellerAgentId, uint256 verifierAgentId, uint256 cumulativeAmount, bytes32 metadataHash, bytes32 catalogRoot, bytes32 usageByServiceRoot, bool accepted) external',
  'function recordUsageReportVerificationWithServiceUsage(bytes32 reportHash, bytes32 channelId, address seller, address buyer, uint256 sellerAgentId, uint256 verifierAgentId, uint256 cumulativeAmount, bytes32 metadataHash, bytes32 catalogRoot, bytes32 usageByServiceRoot, bool accepted, (bytes32 channelId, bytes32 serviceIdHash, bytes32 catalogLeafHash, uint256 serviceMode, uint256 cumulativeFreshInputTokens, uint256 cumulativeCachedInputTokens, uint256 cumulativeOutputTokens, uint256 cumulativeRequestCount, uint256 cumulativeAmountPaid)[] serviceUsageLeaves) external',
] as const;

export class StatsClient extends BaseEvmClient {
  constructor(config: StatsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  /**
   * Fetch and decode all MetadataRecorded logs in the inclusive block range
   * [fromBlock, toBlock]. Returns events sorted by (blockNumber, logIndex) ascending.
   */
  async getMetadataRecordedEvents(params: {
    fromBlock: number;
    toBlock: number;
  }): Promise<DecodedMetadataRecorded[]> {
    const iface = new ethers.Interface(STATS_ABI);
    const topic = iface.getEvent('MetadataRecorded')!.topicHash;

    const logs = await this._provider.getLogs({
      address: this._contractAddress,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      topics: [topic],
    });

    const out: DecodedMetadataRecorded[] = [];
    for (const log of logs) {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed || parsed.name !== 'MetadataRecorded') continue;
      out.push({
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.index,
        agentId: parsed.args[0] as bigint,
        buyer: (parsed.args[1] as string).toLowerCase(),
        channelId: parsed.args[2] as string,
        metadataHash: parsed.args[3] as string,
        inputTokens: parsed.args[4] as bigint,
        outputTokens: parsed.args[5] as bigint,
        requestCount: parsed.args[6] as bigint,
      });
    }
    out.sort((a, b) =>
      a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex,
    );
    return out;
  }

  async getUsageReportVerificationEvents(params: {
    fromBlock: number;
    toBlock: number;
  }): Promise<DecodedUsageReportVerificationRecorded[]> {
    const iface = new ethers.Interface(STATS_ABI);
    const topic = iface.getEvent('UsageReportVerificationRecorded')!.topicHash;

    const logs = await this._provider.getLogs({
      address: this._contractAddress,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      topics: [topic],
    });

    const out: DecodedUsageReportVerificationRecorded[] = [];
    for (const log of logs) {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed || parsed.name !== 'UsageReportVerificationRecorded') continue;
      out.push({
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.index,
        reportHash: parsed.args[0] as string,
        sellerAgentId: parsed.args[1] as bigint,
        verifierAgentId: parsed.args[2] as bigint,
        seller: (parsed.args[3] as string).toLowerCase(),
        buyer: (parsed.args[4] as string).toLowerCase(),
        verifier: (parsed.args[5] as string).toLowerCase(),
        channelId: parsed.args[6] as string,
        metadataHash: parsed.args[7] as string,
        catalogRoot: parsed.args[8] as string,
        usageByServiceRoot: parsed.args[9] as string,
        cumulativeAmount: parsed.args[10] as bigint,
        accepted: parsed.args[11] as boolean,
      });
    }
    out.sort((a, b) =>
      a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex,
    );
    return out;
  }

  async getUsageReportServiceUsageEvents(params: {
    fromBlock: number;
    toBlock: number;
  }): Promise<DecodedUsageReportServiceUsageRecorded[]> {
    const iface = new ethers.Interface(STATS_ABI);
    const topic = iface.getEvent('UsageReportServiceUsageRecorded')!.topicHash;

    const logs = await this._provider.getLogs({
      address: this._contractAddress,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      topics: [topic],
    });

    const out: DecodedUsageReportServiceUsageRecorded[] = [];
    for (const log of logs) {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed || parsed.name !== 'UsageReportServiceUsageRecorded') continue;
      out.push({
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.index,
        reportHash: parsed.args[0] as string,
        sellerAgentId: parsed.args[1] as bigint,
        serviceIdHash: parsed.args[2] as string,
        channelId: parsed.args[3] as string,
        catalogLeafHash: parsed.args[4] as string,
        serviceMode: parsed.args[5] as bigint,
        cumulativeFreshInputTokens: parsed.args[6] as bigint,
        cumulativeCachedInputTokens: parsed.args[7] as bigint,
        cumulativeOutputTokens: parsed.args[8] as bigint,
        cumulativeRequestCount: parsed.args[9] as bigint,
        cumulativeAmountPaid: parsed.args[10] as bigint,
      });
    }
    out.sort((a, b) =>
      a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex,
    );
    return out;
  }

  async recordUsageReportVerification(
    signer: AbstractSigner,
    attestation: ChannelReportAttestationPayload,
    accepted = true,
    serviceUsageLeaves?: readonly ChannelUsageReportServiceUsageLeafPayload[],
  ): Promise<string> {
    const baseArgs = [
      attestation.reportHash,
      attestation.channelId,
      ensureAddress(attestation.seller),
      ensureAddress(attestation.buyer),
      BigInt(attestation.sellerAgentId),
      BigInt(attestation.verifierAgentId),
      BigInt(attestation.cumulativeAmount),
      attestation.metadataHash,
      attestation.catalogRoot,
      attestation.usageByServiceRoot,
      accepted,
    ] as const;

    if (serviceUsageLeaves && serviceUsageLeaves.length > 0) {
      return this._execWrite(
        signer,
        STATS_ABI,
        'recordUsageReportVerificationWithServiceUsage',
        ...baseArgs,
        serviceUsageLeaves.map((leaf) => ({
          channelId: leaf.channelId,
          serviceIdHash: leaf.serviceIdHash,
          catalogLeafHash: leaf.catalogLeafHash,
          serviceMode: BigInt(leaf.serviceMode),
          cumulativeFreshInputTokens: BigInt(leaf.cumulativeFreshInputTokens),
          cumulativeCachedInputTokens: BigInt(leaf.cumulativeCachedInputTokens),
          cumulativeOutputTokens: BigInt(leaf.cumulativeOutputTokens),
          cumulativeRequestCount: BigInt(leaf.cumulativeRequestCount),
          cumulativeAmountPaid: BigInt(leaf.cumulativeAmountPaid),
        })),
      );
    }

    return this._execWrite(
      signer,
      STATS_ABI,
      'recordUsageReportVerification',
      ...baseArgs,
    );
  }

  async getBlockNumber(): Promise<number> {
    return this._provider.getBlockNumber();
  }
}

function ensureAddress(value: string): string {
  return value.startsWith('0x') ? value : `0x${value}`;
}
