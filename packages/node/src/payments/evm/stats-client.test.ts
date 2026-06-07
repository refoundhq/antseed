import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { StatsClient } from './stats-client.js';

const STATS_ABI = [
  'event MetadataRecorded(uint256 indexed agentId, address indexed buyer, bytes32 indexed channelId, bytes32 metadataHash, uint256 inputTokens, uint256 outputTokens, uint256 requestCount)',
  'event UsageReportVerificationRecorded(bytes32 indexed reportHash, uint256 indexed sellerAgentId, uint256 indexed verifierAgentId, address seller, address buyer, address verifier, bytes32 channelId, bytes32 metadataHash, bytes32 pricingSnapshotHash, bytes32 serviceUsageHash, uint256 cumulativeAmount, bool accepted)',
  'event UsageReportServiceUsageRecorded(bytes32 indexed reportHash, uint256 indexed sellerAgentId, bytes32 indexed serviceIdHash, bytes32 channelId, uint256 inputUsdPerMillion, uint256 cachedInputUsdPerMillion, uint256 outputUsdPerMillion, uint256 serviceMode, uint256 cumulativeFreshInputTokens, uint256 cumulativeCachedInputTokens, uint256 cumulativeOutputTokens, uint256 cumulativeRequestCount, uint256 cumulativeAmountPaid)',
] as const;

const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000001';

function makeClient(): StatsClient {
  return new StatsClient({ rpcUrl: 'http://localhost:8545', contractAddress: CONTRACT_ADDRESS });
}

function buildLog(params: {
  agentId: bigint;
  buyer: string;
  channelId: string;
  metadataHash: string;
  inputTokens: bigint;
  outputTokens: bigint;
  requestCount: bigint;
  blockNumber: number;
  transactionHash: string;
  index: number;
}) {
  const iface = new ethers.Interface(STATS_ABI);
  const encoded = iface.encodeEventLog('MetadataRecorded', [
    params.agentId,
    params.buyer,
    params.channelId,
    params.metadataHash,
    params.inputTokens,
    params.outputTokens,
    params.requestCount,
  ]);
  return {
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: params.blockNumber,
    transactionHash: params.transactionHash,
    index: params.index,
    address: CONTRACT_ADDRESS,
  };
}

function buildVerificationLog(params: {
  reportHash: string;
  sellerAgentId: bigint;
  verifierAgentId: bigint;
  seller: string;
  buyer: string;
  verifier: string;
  channelId: string;
  metadataHash: string;
  pricingSnapshotHash: string;
  serviceUsageHash: string;
  cumulativeAmount: bigint;
  accepted: boolean;
  blockNumber: number;
  transactionHash: string;
  index: number;
}) {
  const iface = new ethers.Interface(STATS_ABI);
  const encoded = iface.encodeEventLog('UsageReportVerificationRecorded', [
    params.reportHash,
    params.sellerAgentId,
    params.verifierAgentId,
    params.seller,
    params.buyer,
    params.verifier,
    params.channelId,
    params.metadataHash,
    params.pricingSnapshotHash,
    params.serviceUsageHash,
    params.cumulativeAmount,
    params.accepted,
  ]);
  return {
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: params.blockNumber,
    transactionHash: params.transactionHash,
    index: params.index,
    address: CONTRACT_ADDRESS,
  };
}

function buildServiceUsageLog(params: {
  reportHash: string;
  sellerAgentId: bigint;
  serviceIdHash: string;
  channelId: string;
  inputUsdPerMillion: bigint;
  cachedInputUsdPerMillion: bigint;
  outputUsdPerMillion: bigint;
  serviceMode: bigint;
  cumulativeFreshInputTokens: bigint;
  cumulativeCachedInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  cumulativeAmountPaid: bigint;
  blockNumber: number;
  transactionHash: string;
  index: number;
}) {
  const iface = new ethers.Interface(STATS_ABI);
  const encoded = iface.encodeEventLog('UsageReportServiceUsageRecorded', [
    params.reportHash,
    params.sellerAgentId,
    params.serviceIdHash,
    params.channelId,
    params.inputUsdPerMillion,
    params.cachedInputUsdPerMillion,
    params.outputUsdPerMillion,
    params.serviceMode,
    params.cumulativeFreshInputTokens,
    params.cumulativeCachedInputTokens,
    params.cumulativeOutputTokens,
    params.cumulativeRequestCount,
    params.cumulativeAmountPaid,
  ]);
  return {
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: params.blockNumber,
    transactionHash: params.transactionHash,
    index: params.index,
    address: CONTRACT_ADDRESS,
  };
}

describe('StatsClient', () => {
  it('decodes a MetadataRecorded log into a DecodedMetadataRecorded', async () => {
    const agentId = 42n;
    const buyer = ethers.getAddress('0xabcdef1234567890abcdef1234567890abcdef12');
    const channelId = '0x' + 'ab'.repeat(32);
    const metadataHash = '0x' + 'cd'.repeat(32);
    const inputTokens = 100n;
    const outputTokens = 200n;
    const requestCount = 5n;
    const blockNumber = 1000;
    const transactionHash = '0x' + 'ff'.repeat(32);
    const logIndex = 3;

    const cannedLog = buildLog({
      agentId,
      buyer,
      channelId,
      metadataHash,
      inputTokens,
      outputTokens,
      requestCount,
      blockNumber,
      transactionHash,
      index: logIndex,
    });

    const client = makeClient();
    (client as any)._provider.getLogs = async () => [cannedLog];

    const events = await client.getMetadataRecordedEvents({ fromBlock: 0, toBlock: 1 });

    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.agentId).toBe(agentId);
    expect(evt.buyer).toBe(buyer.toLowerCase());
    expect(evt.channelId).toBe(channelId);
    expect(evt.metadataHash).toBe(metadataHash);
    expect(evt.inputTokens).toBe(inputTokens);
    expect(evt.outputTokens).toBe(outputTokens);
    expect(evt.requestCount).toBe(requestCount);
    expect(evt.blockNumber).toBe(blockNumber);
    expect(evt.txHash).toBe(transactionHash);
    expect(evt.logIndex).toBe(logIndex);
  });

  it('sorts events ascending by (blockNumber, logIndex)', async () => {
    const base = {
      agentId: 1n,
      buyer: '0x0000000000000000000000000000000000000002',
      channelId: '0x' + '11'.repeat(32),
      metadataHash: '0x' + '22'.repeat(32),
      inputTokens: 10n,
      outputTokens: 20n,
      requestCount: 1n,
      transactionHash: '0x' + '00'.repeat(32),
    };

    // Insert out of order: block 5 logIndex 0, block 3 logIndex 1, block 3 logIndex 0
    const log1 = buildLog({ ...base, blockNumber: 5, index: 0 });
    const log2 = buildLog({ ...base, blockNumber: 3, index: 1 });
    const log3 = buildLog({ ...base, blockNumber: 3, index: 0 });

    const client = makeClient();
    (client as any)._provider.getLogs = async () => [log1, log2, log3];

    const events = await client.getMetadataRecordedEvents({ fromBlock: 0, toBlock: 10 });

    expect(events).toHaveLength(3);
    expect(events[0].blockNumber).toBe(3);
    expect(events[0].logIndex).toBe(0);
    expect(events[1].blockNumber).toBe(3);
    expect(events[1].logIndex).toBe(1);
    expect(events[2].blockNumber).toBe(5);
    expect(events[2].logIndex).toBe(0);
  });

  it('filters out logs that do not parse as MetadataRecorded', async () => {
    // Build a valid log for a different event (unknown topic) by altering the first topic
    const goodLog = buildLog({
      agentId: 1n,
      buyer: '0x0000000000000000000000000000000000000003',
      channelId: '0x' + 'aa'.repeat(32),
      metadataHash: '0x' + 'bb'.repeat(32),
      inputTokens: 1n,
      outputTokens: 2n,
      requestCount: 1n,
      blockNumber: 100,
      transactionHash: '0x' + '11'.repeat(32),
      index: 0,
    });

    // A log with a different (unrecognized) topic — parseLog will return null
    const badLog = {
      ...goodLog,
      topics: [
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        ...goodLog.topics.slice(1),
      ],
    };

    const client = makeClient();
    (client as any)._provider.getLogs = async () => [goodLog, badLog];

    const events = await client.getMetadataRecordedEvents({ fromBlock: 0, toBlock: 200 });

    // Only the valid MetadataRecorded log should be decoded; the bad one is filtered out
    expect(events).toHaveLength(1);
  });

  it('decodes UsageReportVerificationRecorded logs', async () => {
    const reportHash = '0x' + '12'.repeat(32);
    const seller = ethers.getAddress('0x0000000000000000000000000000000000000011');
    const buyer = ethers.getAddress('0x0000000000000000000000000000000000000022');
    const verifier = ethers.getAddress('0x0000000000000000000000000000000000000033');
    const channelId = '0x' + 'ab'.repeat(32);
    const metadataHash = '0x' + 'cd'.repeat(32);
    const pricingSnapshotHash = '0x' + 'ef'.repeat(32);
    const serviceUsageHash = '0x' + '01'.repeat(32);
    const transactionHash = '0x' + 'ff'.repeat(32);

    const client = makeClient();
    (client as any)._provider.getLogs = async () => [buildVerificationLog({
      reportHash,
      sellerAgentId: 42n,
      verifierAgentId: 77n,
      seller,
      buyer,
      verifier,
      channelId,
      metadataHash,
      pricingSnapshotHash,
      serviceUsageHash,
      cumulativeAmount: 50_000_000n,
      accepted: true,
      blockNumber: 100,
      transactionHash,
      index: 7,
    })];

    const events = await client.getUsageReportVerificationEvents({ fromBlock: 0, toBlock: 100 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      blockNumber: 100,
      txHash: transactionHash,
      logIndex: 7,
      reportHash,
      sellerAgentId: 42n,
      verifierAgentId: 77n,
      seller: seller.toLowerCase(),
      buyer: buyer.toLowerCase(),
      verifier: verifier.toLowerCase(),
      channelId,
      metadataHash,
      pricingSnapshotHash,
      serviceUsageHash,
      cumulativeAmount: 50_000_000n,
      accepted: true,
    });
  });

  it('decodes UsageReportServiceUsageRecorded logs', async () => {
    const reportHash = '0x' + '12'.repeat(32);
    const serviceIdHash = '0x' + '34'.repeat(32);
    const channelId = '0x' + 'ab'.repeat(32);
    const transactionHash = '0x' + 'ff'.repeat(32);

    const client = makeClient();
    (client as any)._provider.getLogs = async () => [buildServiceUsageLog({
      reportHash,
      sellerAgentId: 42n,
      serviceIdHash,
      channelId,
      inputUsdPerMillion: 3n,
      cachedInputUsdPerMillion: 1n,
      outputUsdPerMillion: 15n,
      serviceMode: 1n,
      cumulativeFreshInputTokens: 100n,
      cumulativeCachedInputTokens: 20n,
      cumulativeOutputTokens: 50n,
      cumulativeRequestCount: 3n,
      cumulativeAmountPaid: 12345n,
      blockNumber: 101,
      transactionHash,
      index: 8,
    })];

    const events = await client.getUsageReportServiceUsageEvents({ fromBlock: 0, toBlock: 200 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      blockNumber: 101,
      txHash: transactionHash,
      logIndex: 8,
      reportHash,
      sellerAgentId: 42n,
      serviceIdHash,
      channelId,
      inputUsdPerMillion: 3n,
      cachedInputUsdPerMillion: 1n,
      outputUsdPerMillion: 15n,
      serviceMode: 1n,
      cumulativeFreshInputTokens: 100n,
      cumulativeCachedInputTokens: 20n,
      cumulativeOutputTokens: 50n,
      cumulativeRequestCount: 3n,
      cumulativeAmountPaid: 12345n,
    });
  });
});
