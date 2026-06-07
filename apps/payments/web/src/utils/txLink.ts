export function getExplorerTxUrl(txHash: string, chainId?: number): string | null {
  if (!txHash) return null;
  if (chainId === 8453) return `https://basescan.org/tx/${txHash}`;
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${txHash}`;
  return null;
}
