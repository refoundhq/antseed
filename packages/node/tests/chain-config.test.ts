import { describe, expect, it } from 'vitest';
import { getChainConfig } from '../src/payments/chain-config.js';

describe('chain config', () => {
  it('keeps base-local addresses aligned with Deploy.s.sol nonce order', () => {
    const config = getChainConfig('base-local');

    expect(config.channelsContractAddress).toBe('0x0165878A594ca255338adfa4d48449f69242Eb8F');
    expect(config.usageReportStatsContractAddress).toBe('0xa513E6E4b8f2a923D98304ec87F64353C4D5C853');
    expect(config.emissionsContractAddress).toBe('0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6');
    expect(config.subPoolContractAddress).toBe('0x8A791620dd6260079BF849Dc5567aDC3F2FdC318');
  });
});
