import type { ReactNode } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';

interface ConnectWalletActionState {
  ready: boolean;
  connected: boolean;
  openConnectModal: () => void;
}

interface ConnectWalletActionProps {
  children?: (state: ConnectWalletActionState) => ReactNode;
  className?: string;
  disabled?: boolean;
  label?: ReactNode;
}

export function ConnectWalletAction({
  children,
  className,
  disabled,
  label = 'Connect wallet',
}: ConnectWalletActionProps) {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, authenticationStatus, mounted }) => {
        const ready = mounted && authenticationStatus !== 'loading';
        const connected = Boolean(
          ready &&
            account &&
            chain &&
          (!authenticationStatus || authenticationStatus === 'authenticated'),
        );

        if (children) return children({ ready, connected, openConnectModal });
        return connected ? null : (
          <button
            type="button"
            className={className}
            onClick={openConnectModal}
            disabled={!ready || disabled}
          >
            {label}
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
