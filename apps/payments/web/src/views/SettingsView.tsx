import { useEffect, useState } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import type { PaymentConfig } from '../types';
import { getRpcHealth } from '../api';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';
import { ConnectWalletAction } from '../components/ConnectWalletAction';
import { truncateAddress } from '../utils/format';

interface SettingsViewProps {
  config: PaymentConfig | null;
}

type RpcStatus =
  | { state: 'checking' }
  | { state: 'reachable'; blockNumber: number; latencyMs: number }
  | { state: 'unreachable'; error: string }
  | { state: 'unconfigured' };

function getRpcStatusClass(status: RpcStatus): string {
  if (status.state === 'reachable') return 'set-pill--ok';
  if (status.state === 'checking') return 'set-pill--muted';
  return 'set-pill--warn';
}

function getRpcStatusLabel(status: RpcStatus): string {
  if (status.state === 'reachable') return 'reachable';
  if (status.state === 'checking') return 'checking';
  if (status.state === 'unconfigured') return 'not configured';
  return 'unreachable';
}

export function SettingsView({ config }: SettingsViewProps) {
  const { operatorSet, operator, requireAuthorization } = useAuthorizedWallet();
  const { address: connectedAddress, isConnected, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const [rpcStatus, setRpcStatus] = useState<RpcStatus>({ state: 'checking' });

  useEffect(() => {
    if (!config?.rpcUrl) {
      setRpcStatus({ state: 'unconfigured' });
      return;
    }

    let cancelled = false;
    setRpcStatus({ state: 'checking' });
    getRpcHealth()
      .then((health) => {
        if (cancelled) return;
        setRpcStatus({
          state: 'reachable',
          blockNumber: health.blockNumber,
          latencyMs: health.latencyMs,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setRpcStatus({
          state: 'unreachable',
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return () => { cancelled = true; };
  }, [config?.rpcUrl]);

  return (
    <div className="settings-view">
      <div className="settings-grid settings-grid--focused">
        <div className="settings-cell">
          <div className="settings-section-label">Wallet</div>
          <div className="settings-card">
            <div className="set-item">
              <div className="set-copy">
                <h4>Connected wallet</h4>
                <p>
                  The external wallet used to sign and submit on-chain actions
                  (withdrawals, claims, channel closes).
                </p>
              </div>
              <div className="set-ctrl set-wallet-ctrl">
                {isConnected && connectedAddress ? (
                  <>
                    <span className="set-wallet-addr">{truncateAddress(connectedAddress)}</span>
                    {connector?.name && <span className="set-wallet-provider">{connector.name}</span>}
                    <button
                      type="button"
                      className="set-btn-ghost"
                      onClick={() => disconnect()}
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <ConnectWalletAction className="set-btn-ghost" />
                )}
              </div>
            </div>

            <div className="set-item">
              <div className="set-copy">
                <h4>Authorized wallet</h4>
                <p>
                  Your AntSeed node signs spending requests but never holds USDC or ANTS.
                  This external wallet can recover funds and claim rewards.
                </p>
              </div>
              <div className="set-ctrl">
                {operatorSet ? (
                  <>
                    <span className="set-wallet-addr">{operator ? truncateAddress(operator) : 'Not configured'}</span>
                    <span className="set-pill set-pill--ok">
                      <span className="set-pill-dot" aria-hidden="true" />
                      authorized
                    </span>
                  </>
                ) : (
                  <button
                    type="button"
                    className="set-btn-ghost"
                    disabled={operatorSet === null}
                    onClick={() => requireAuthorization()}
                  >
                    {operatorSet === null ? 'Checking…' : 'Authorize wallet'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="settings-cell">
          <div className="settings-section-label">Network</div>
          <div className="settings-card">
            <div className="set-item">
              <div className="set-copy">
                <h4>Chain</h4>
                <p>Network the AntSeed protocol contracts live on.</p>
              </div>
              <div className="set-ctrl">
                <span className="set-value">{config?.chainId ?? 'Unknown'}</span>
                <span className={`set-pill ${getRpcStatusClass(rpcStatus)}`}>
                  <span className="set-pill-dot" aria-hidden="true" />
                  {getRpcStatusLabel(rpcStatus)}
                </span>
                {rpcStatus.state === 'reachable' && (
                  <span className="set-wallet-provider">block {rpcStatus.blockNumber.toLocaleString('en-US')}</span>
                )}
                {rpcStatus.state === 'unreachable' && (
                  <span className="set-wallet-provider">{rpcStatus.error}</span>
                )}
              </div>
            </div>

            <div className="set-item set-item-stack">
              <div className="set-copy">
                <h4>RPC endpoint</h4>
                <p>Configured by the active AntSeed node. Change it in node config, then reopen the portal.</p>
              </div>
              <div className="set-input-row">
                <input
                  className="set-input"
                  value={config?.rpcUrl ?? ''}
                  readOnly
                  placeholder="http://127.0.0.1:8545"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
