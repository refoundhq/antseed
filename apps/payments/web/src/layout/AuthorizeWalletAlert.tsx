import { Alert, Button } from '@antseed/ui';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';

export function AuthorizeWalletAlert() {
  const { operatorSet, requireAuthorization } = useAuthorizedWallet();

  if (operatorSet !== false) return null;

  return (
    <Alert
      className="payment-authorize-alert"
      tone="warning"
      title="Your funds are not recoverable yet"
      action={(
        <Button
          size="sm"
          onClick={() => requireAuthorization()}
        >
          Authorize now
        </Button>
      )}
    >
      Authorize an external wallet so you can withdraw USDC, claim ANTS, and close
      channels. Without one, losing this node means losing your funds.
    </Alert>
  );
}
