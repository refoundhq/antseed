import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AntseedNode } from '../src/node.js';

const RPC_URL = 'http://127.0.0.1:8545';
const LEGACY_STATS = '0x' + '11'.repeat(20);
const STATS_V2 = '0x' + '22'.repeat(20);

describe('AntseedNode payments config', () => {
  it('does not initialize usage-report recording from legacy statsAddress', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'node-payments-config-'));
    const node = new AntseedNode({
      role: 'buyer',
      payments: {
        enabled: true,
        rpcUrl: RPC_URL,
        statsAddress: LEGACY_STATS,
      },
    });

    try {
      await (node as unknown as { _initializePayments: (dataDir: string) => Promise<void> })._initializePayments(dataDir);
      expect((node as unknown as { _statsClient: unknown })._statsClient).toBeNull();
    } finally {
      (node as unknown as { _channelStore: { close: () => void } | null })._channelStore?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('initializes usage-report recording from explicit StatsV2 address', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'node-payments-config-'));
    const node = new AntseedNode({
      role: 'buyer',
      payments: {
        enabled: true,
        rpcUrl: RPC_URL,
        statsAddress: LEGACY_STATS,
        usageReportStatsAddress: STATS_V2,
      },
    });

    try {
      await (node as unknown as { _initializePayments: (dataDir: string) => Promise<void> })._initializePayments(dataDir);
      const statsClient = (node as unknown as { _statsClient: { contractAddress: string } | null })._statsClient;
      expect(statsClient?.contractAddress).toBe(STATS_V2);
    } finally {
      (node as unknown as { _channelStore: { close: () => void } | null })._channelStore?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
