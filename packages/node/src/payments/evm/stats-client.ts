import { ethers, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import type { ChannelReportAttestationPayload } from '../../types/protocol.js';

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

const STATS_ABI = [
  'event MetadataRecorded(uint256 indexed agentId, address indexed buyer, bytes32 indexed channelId, bytes32 metadataHash, uint256 inputTokens, uint256 outputTokens, uint256 requestCount)',
  'event UsageReportVerificationRecorded(bytes32 indexed reportHash, uint256 indexed sellerAgentId, uint256 indexed verifierAgentId, address seller, address buyer, address verifier, bytes32 channelId, bytes32 metadataHash, bytes32 catalogRoot, bytes32 usageByServiceRoot, uint256 cumulativeAmount, bool accepted)',
  'function recordUsageReportVerification(bytes32 reportHash, bytes32 channelId, address seller, address buyer, uint256 sellerAgentId, uint256 verifierAgentId, uint256 cumulativeAmount, bytes32 metadataHash, bytes32 catalogRoot, bytes32 usageByServiceRoot, bool accepted) external',
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

  async recordUsageReportVerification(
    signer: AbstractSigner,
    attestation: ChannelReportAttestationPayload,
    accepted = true,
  ): Promise<string> {
    return this._execWrite(
      signer,
      STATS_ABI,
      'recordUsageReportVerification',
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
    );
  }

  async getBlockNumber(): Promise<number> {
    return this._provider.getBlockNumber();
  }
}

function ensureAddress(value: string): string {
  return value.startsWith('0x') ? value : `0x${value}`;
}
