import { Alert, Button } from '@antseed/ui';
import styles from './LowBalanceWarning.module.scss';

type LowBalanceWarningProps = {
  visible: boolean;
  availableUsdc: string;
  onAddCredits: () => void;
};

export function LowBalanceWarning({ visible, availableUsdc, onAddCredits }: LowBalanceWarningProps) {
  if (!visible) return null;

  return (
    <Alert
      className={styles.lowBalanceWarning}
      tone="warning"
      action={(
        <Button
          className={styles.addCreditsLink}
          size="sm"
          variant="ghost"
          onClick={onAddCredits}
        >
          Add Credits
        </Button>
      )}
    >
      <span className={styles.warningText}>
        Your balance is running low (${parseFloat(availableUsdc).toFixed(2)} remaining).
        Add credits to continue using paid services.
      </span>
    </Alert>
  );
}
