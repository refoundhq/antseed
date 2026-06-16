import { useState } from 'react';
import { useAccount } from 'wagmi';
import type { BalanceData, PaymentConfig } from '../types';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';
import { useWithdraw } from '../hooks/useWithdraw';
import { usePaymentNetwork } from '../payment-network';
import { formatUsd, truncateAddress } from '../utils/format';
import { Button } from './Button';
import { ConnectWalletAction } from './ConnectWalletAction';
import './WithdrawView.scss';

interface WithdrawViewProps {
  config: PaymentConfig | null;
  balance: BalanceData | null;
  onAction: () => void;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export function WithdrawView({ config, balance, onAction }: WithdrawViewProps) {
  const [amount, setAmount] = useState('');
  const { address, isConnected } = useAccount();
  const walletConnected = isConnected && Boolean(address);
  const { requireAuthorization, operator } = useAuthorizedWallet();
  const { targetChainName, walletChainId, wrongChain, isSwitchingChain } = usePaymentNetwork(config);

  const { run, running, success, error, reset, txHash } = useWithdraw(config, () => {
    onAction();
  });

  if (!balance) {
    return (
      <div className="card">
        <div className="card-section-title">Withdraw</div>
        <div className="withdraw-loading">Loading...</div>
      </div>
    );
  }

  const availableAmount = parseFloat(balance.available);
  const buyer = config?.evmAddress ?? balance.evmAddress;

  const operatorSet = !!operator && operator !== ZERO_ADDR;
  const wrongWallet = Boolean(
    walletConnected && operatorSet && address && address.toLowerCase() !== operator!.toLowerCase(),
  );

  const amountNum = amount ? parseFloat(amount) : 0;
  const validAmount = Number.isFinite(amountNum) && amountNum > 0 && amountNum <= availableAmount;

  function handleClick() {
    if (!buyer) return;
    requireAuthorization(async () => {
      reset();
      await run(buyer, amount);
    });
  }

  function resetForm() {
    setAmount('');
    reset();
  }

  return (
    <div className="withdraw">
      <div className="card">
        <div className="card-section-title">Withdraw USDC</div>
        <div className="wallet-role-hint">
          Withdrawals are sent to your authorized wallet. You'll be prompted to
          authorize one if you haven't already.
        </div>

        {success ? (
          <div className="deposit-success">
            <div className="deposit-success-icon">&#10003;</div>
            <div className="deposit-success-title">Withdrawal confirmed!</div>
            {txHash && <div className="deposit-success-hash">{txHash.slice(0, 18)}...</div>}
            <div className="deposit-success-note">
              Funds were sent to {address ? truncateAddress(address, 6, 4, '...') : 'your authorized wallet'}.
            </div>
            <Button fullWidth variant="outline" onClick={resetForm} style={{ marginTop: 12 }}>
              Withdraw more
            </Button>
          </div>
        ) : !walletConnected ? (
          <div className="deposit-connect-wrapper">
            <ConnectWalletAction>
              {({ openConnectModal, ready, connected }) => connected ? null : (
                <Button
                  fullWidth
                  onClick={openConnectModal}
                  disabled={!ready}
                >
                  Connect Wallet
                </Button>
              )}
            </ConnectWalletAction>
          </div>
        ) : (
          <>
            <div className="deposit-connected">
              <div className="deposit-connected-dot" />
              <span className="deposit-connected-addr">{address ? truncateAddress(address, 6, 4, '...') : ''}</span>
              <span className="deposit-connected-label">Connected</span>
            </div>

            {wrongChain && (
              <div className="status-msg" style={{ marginTop: 0, marginBottom: 16 }}>
                Wallet is on chain {walletChainId ?? 'unknown'}. Switch to {targetChainName} before withdrawing.
              </div>
            )}

            {wrongWallet && operator && (
              <div className="status-msg status-error" role="alert" style={{ marginBottom: 16 }}>
                This account is authorized to <strong>{truncateAddress(operator, 6, 4, '...')}</strong>. Connect that wallet
                to withdraw, or transfer authorization to the connected wallet first.
              </div>
            )}

            <div className="withdraw-request">
              <div className="input-group">
                <label className="input-label">Amount (USDC)</label>
                <input
                  className="input-field"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={running}
                />
                <span className="hint">Available: ${formatUsd(availableAmount)} USDC</span>
              </div>

              <Button
                fullWidth
                onClick={handleClick}
                disabled={
                  running ||
                  isSwitchingChain ||
                  !validAmount ||
                  !buyer ||
                  wrongWallet ||
                  !config
                }
              >
                {isSwitchingChain ? `Switching to ${targetChainName}...` :
                 wrongChain ? `Switch to ${targetChainName}` :
                 running ? 'Processing...' :
                 'Withdraw'}
              </Button>
            </div>
          </>
        )}

        {error && (
          <div className="status-msg status-error">{error}</div>
        )}
      </div>
    </div>
  );
}
