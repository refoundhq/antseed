import { useEffect, useState } from 'react';
import { Button, Modal } from '@antseed/ui';
import styles from './SwitchServiceDialog.module.scss';

type SwitchServiceDialogProps = {
  visible: boolean;
  currentLabel: string;
  nextLabel: string;
  onContinue: (dontShowAgain: boolean) => void;
  onStartNew: (dontShowAgain: boolean) => void;
  onCancel: () => void;
};

export function SwitchServiceDialog({
  visible,
  currentLabel,
  nextLabel,
  onContinue,
  onStartNew,
  onCancel,
}: SwitchServiceDialogProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    if (visible) setDontShowAgain(false);
  }, [visible]);

  return (
    <Modal
      bodyClassName={styles.dialogBody}
      isOpen={visible}
      onClose={onCancel}
      size="sm"
      title="Switch service?"
    >
      <p className={styles.body}>
        You&apos;re switching from <strong>{currentLabel}</strong> to <strong>{nextLabel}</strong>.
        Starting a new chat usually gives better results — different models handle
        conversation context differently.
      </p>
      <label className={styles.dontShowRow}>
        <input
          type="checkbox"
          checked={dontShowAgain}
          onChange={(e) => setDontShowAgain(e.target.checked)}
        />
        Don&apos;t show this again
      </label>
      <div className={styles.actions}>
        <Button variant="outline" onClick={() => onContinue(dontShowAgain)}>
          Continue in this chat
        </Button>
        <Button onClick={() => onStartNew(dontShowAgain)}>
          Start new chat
        </Button>
      </div>
    </Modal>
  );
}
