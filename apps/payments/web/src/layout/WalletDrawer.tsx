import { useEffect, useState, useCallback } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import type { BalanceData, PaymentConfig } from '../types';
import { useSetOperator, useTransferOperator } from '../hooks/useSetOperator';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';
import { Button, Drawer, TextField } from '@antseed/ui';
import { InfoHint } from '../components/InfoHint';

interface WalletDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  balance: BalanceData | null;
  config: PaymentConfig | null;
  buyerEvmAddress: string | null;
  onOpenDeposit: () => void;
  onOpenWithdraw: () => void;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function truncate(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 10.5V3.5C3 2.67 3.67 2 4.5 2H10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8.5L6.5 11.5L12.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function useCopyable() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
    } catch {
      // clipboard blocked — ignore
    }
  }, []);
  return { copied, copy };
}

export function WalletDrawer({
  isOpen,
  onClose,
  balance,
  config,
  buyerEvmAddress,
  onOpenDeposit,
  onOpenWithdraw,
}: WalletDrawerProps) {
  const { address: connectedAddress, isConnected, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const { copied, copy } = useCopyable();

  const { operator: onChainOperator, operatorSet, refetch: refetchOperator } = useAuthorizedWallet();
  const operatorLoading = operatorSet === null;

  const setOperator = useSetOperator(config, refetchOperator);
  const transferOperator = useTransferOperator(config, refetchOperator);
  const [transferAddr, setTransferAddr] = useState('');
  const [showTransfer, setShowTransfer] = useState(false);

  useEffect(() => {
    if (isOpen) void refetchOperator();
  }, [isOpen, refetchOperator]);

  useEffect(() => {
    if (!isOpen) { setShowTransfer(false); setTransferAddr(''); transferOperator.reset(); }
  }, [isOpen]);

  const hasOperator = Boolean(
    onChainOperator && onChainOperator.toLowerCase() !== ZERO_ADDR,
  );
  const operatorMatchesConnected = Boolean(
    hasOperator &&
      connectedAddress &&
      onChainOperator &&
      onChainOperator.toLowerCase() === connectedAddress.toLowerCase(),
  );

  const available = balance ? parseFloat(balance.available) : 0;
  const reserved = balance ? parseFloat(balance.reserved) : 0;
  const total = balance ? parseFloat(balance.total) : 0;

  function handleDepositMore() {
    onOpenDeposit();
  }

  function handleWithdraw() {
    onOpenWithdraw();
  }

  return (
    <Drawer
      closeLabel="Close wallet"
      eyebrow="Wallet"
      isOpen={isOpen}
      onClose={onClose}
      side="right"
      title="Accounts & balances"
    >
          {/* ── AntSeed account ───────────────────────────────── */}
          <section className="wallet-panel-section">
            <div className="wallet-panel-section-label">Your AntSeed account</div>
            <div className="wallet-panel-card">
              <div className="wallet-panel-card-row">
                <div className="wallet-panel-role">
                  <span className="wallet-panel-role-dot wallet-panel-role-dot--signer" />
                  Signer
                  <InfoHint>
                    <p>
                      Your signer authorizes spending from your AntSeed account — it
                      never holds USDC itself. The balance lives in the
                      AntseedDeposits contract, tracked under this address. Your
                      signer never needs gas.
                    </p>
                  </InfoHint>
                </div>
                <button
                  type="button"
                  className={`wallet-panel-addr${copied === 'buyer' ? ' wallet-panel-addr--copied' : ''}`}
                  onClick={() => buyerEvmAddress && copy(buyerEvmAddress, 'buyer')}
                  disabled={!buyerEvmAddress}
                  title={buyerEvmAddress ?? ''}
                >
                  <span className="wallet-panel-addr-value">
                    {buyerEvmAddress ? truncate(buyerEvmAddress) : '—'}
                  </span>
                  <span className="wallet-panel-addr-icon">
                    {copied === 'buyer' ? <CheckIcon /> : <CopyIcon />}
                  </span>
                </button>
              </div>
            </div>

            <div className="wallet-panel-balances">
              <div className="wallet-panel-balance">
                <span className="wallet-panel-balance-label">Available</span>
                <span className="wallet-panel-balance-value">${formatUsd(available)}</span>
              </div>
              <div className="wallet-panel-balance">
                <span className="wallet-panel-balance-label">Reserved</span>
                <span className="wallet-panel-balance-value">${formatUsd(reserved)}</span>
              </div>
              <div className="wallet-panel-balance">
                <span className="wallet-panel-balance-label">Total</span>
                <span className="wallet-panel-balance-value">${formatUsd(total)}</span>
              </div>
            </div>

            <div className="wallet-panel-actions">
              <Button variant="primary" fullWidth onClick={handleDepositMore}>
                Deposit more
              </Button>
              <Button variant="outline" fullWidth onClick={handleWithdraw}>
                Withdraw
              </Button>
            </div>
          </section>

          {/* ── Your wallet ───────────────────────────────────── */}
          <section className="wallet-panel-section">
            <div className="wallet-panel-section-label">Your wallet</div>

            {!isConnected ? (
              <div className="wallet-panel-card">
                <div className="wallet-panel-role">
                  <span className="wallet-panel-role-dot wallet-panel-role-dot--operator" />
                  Wallet
                </div>
                <p className="wallet-panel-explainer">
                  Connect a wallet to receive withdrawals, claim ANTS rewards, and
                  submit on-chain actions for your account. Deposits from any wallet
                  fund your AntSeed account above.
                </p>
                <div className="wallet-panel-connect-wrap">
                  <ConnectButton.Custom>
                    {({ openConnectModal, mounted }) => (
                      <Button
                        onClick={openConnectModal}
                        disabled={!mounted}
                      >
                        Connect wallet
                      </Button>
                    )}
                  </ConnectButton.Custom>
                </div>
              </div>
            ) : (
              <div className="wallet-panel-card">
                <div className="wallet-panel-card-row">
                  <div className="wallet-panel-role">
                    <span className="wallet-panel-role-dot wallet-panel-role-dot--operator" />
                    Connected
                  </div>
                  <button
                    type="button"
                    className={`wallet-panel-addr${copied === 'operator' ? ' wallet-panel-addr--copied' : ''}`}
                    onClick={() => connectedAddress && copy(connectedAddress, 'operator')}
                    title={connectedAddress ?? ''}
                  >
                    <span className="wallet-panel-addr-value">
                      {connectedAddress ? truncate(connectedAddress) : '—'}
                    </span>
                    <span className="wallet-panel-addr-icon">
                      {copied === 'operator' ? <CheckIcon /> : <CopyIcon />}
                    </span>
                  </button>
                </div>

                <div className="wallet-panel-meta">
                  <span className="wallet-panel-meta-label">Provider</span>
                  <span className="wallet-panel-meta-value">{connector?.name ?? 'Unknown'}</span>
                </div>

                <div className="wallet-panel-operator-status">
                  {operatorLoading ? (
                    <span className="wallet-panel-pill wallet-panel-pill--muted">
                      Checking authorization…
                    </span>
                  ) : operatorMatchesConnected ? (
                    <>
                      <span className="wallet-panel-pill wallet-panel-pill--ok">
                        <CheckIcon /> Authorized for withdrawals
                      </span>
                    </>
                  ) : hasOperator ? (
                    <div className="wallet-panel-warn">
                      <div className="wallet-panel-warn-title">Wrong wallet connected</div>
                      <div className="wallet-panel-warn-desc">
                        Switch to <strong>{onChainOperator ? truncate(onChainOperator) : ''}</strong> in
                        your wallet app to withdraw, claim ANTS, and close channels.
                      </div>
                    </div>
                  ) : null}
                </div>

                {!operatorMatchesConnected && !operatorLoading && !hasOperator && (
                  <div className="wallet-panel-authorize-row">
                    <button
                      type="button"
                      className="wallet-panel-link wallet-panel-link--accent"
                      onClick={() => void setOperator.run()}
                      disabled={setOperator.running || !config}
                    >
                      {setOperator.running ? 'Authorizing…' : 'Authorize this wallet'}
                    </button>
                    <InfoHint variant="warn">
                      <p>
                        Without an authorized wallet you cannot withdraw USDC, claim ANTS,
                        or close channels. If you lose access to this node, your funds
                        become unrecoverable. Authorize this wallet to keep your funds safe.
                      </p>
                    </InfoHint>
                  </div>
                )}

                {operatorMatchesConnected && !showTransfer && (
                  <button
                    type="button"
                    className="wallet-panel-link"
                    onClick={() => setShowTransfer(true)}
                  >
                    Transfer authorization to another wallet
                  </button>
                )}

                {operatorMatchesConnected && showTransfer && (
                  <div className="wallet-panel-section">
                    <div className="wallet-panel-section-label">Transfer to</div>
                    <TextField
                      type="text"
                      placeholder="0x..."
                      value={transferAddr}
                      onChange={(e) => setTransferAddr(e.target.value)}
                      disabled={transferOperator.running}
                    />
                    <Button
                      variant="danger"
                      onClick={() => buyerEvmAddress && void transferOperator.run(buyerEvmAddress, transferAddr)}
                      disabled={transferOperator.running || !transferAddr || !buyerEvmAddress}
                    >
                      {transferOperator.running ? 'Transferring…' : 'Transfer authorization'}
                    </Button>
                    {transferOperator.error && (
                      <div className="wallet-panel-error">{transferOperator.error}</div>
                    )}
                  </div>
                )}

                {setOperator.error && (
                  <div className="wallet-panel-error">{setOperator.error}</div>
                )}

                <button
                  type="button"
                  className="wallet-panel-link"
                  onClick={() => disconnect()}
                >
                  Disconnect
                </button>
              </div>
            )}

            <p className="wallet-panel-footnote">
              Deposits can come from any wallet and fund your AntSeed account.
              Withdrawals are sent to the wallet you authorize here.
            </p>
          </section>
    </Drawer>
  );
}
