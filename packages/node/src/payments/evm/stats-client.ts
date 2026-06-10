import { ethers } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

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

export interface DecodedMetadataPointerRecorded {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  agentId: bigint;
  buyer: string;
  channelId: string;
  metadataHash: string;
  cid: string;
  cidBytes: string;
  usageRoot: string;
}

const STATS_ABI = [
  'event MetadataRecorded(uint256 indexed agentId, address indexed buyer, bytes32 indexed channelId, bytes32 metadataHash, uint256 inputTokens, uint256 outputTokens, uint256 requestCount)',
  'event MetadataPointerRecorded(uint256 indexed agentId, address indexed buyer, bytes32 indexed channelId, bytes32 metadataHash, bytes cid, bytes32 usageRoot)',
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

  async getMetadataPointerRecordedEvents(params: {
    fromBlock: number;
    toBlock: number;
  }): Promise<DecodedMetadataPointerRecorded[]> {
    const iface = new ethers.Interface(STATS_ABI);
    const topic = iface.getEvent('MetadataPointerRecorded')!.topicHash;

    const logs = await this._provider.getLogs({
      address: this._contractAddress,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      topics: [topic],
    });

    const out: DecodedMetadataPointerRecorded[] = [];
    for (const log of logs) {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed || parsed.name !== 'MetadataPointerRecorded') continue;
      const cidBytes = parsed.args[4] as string;
      out.push({
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.index,
        agentId: parsed.args[0] as bigint,
        buyer: (parsed.args[1] as string).toLowerCase(),
        channelId: parsed.args[2] as string,
        metadataHash: parsed.args[3] as string,
        cid: decodeCid(cidBytes),
        cidBytes,
        usageRoot: parsed.args[5] as string,
      });
    }
    out.sort((a, b) =>
      a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex,
    );
    return out;
  }

  async getBlockNumber(): Promise<number> {
    return this._provider.getBlockNumber();
  }
}

function decodeCid(cidBytes: string): string {
  try {
    const bytes = ethers.getBytes(cidBytes);
    const decoded = new TextDecoder().decode(bytes);
    // Advisory display value only; indexers should preserve cidBytes as canonical.
    if (/^[\x21-\x7e]+$/.test(decoded)) return decoded;
  } catch { /* fall through */ }
  return cidBytes;
}
