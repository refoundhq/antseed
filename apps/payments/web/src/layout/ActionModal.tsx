import { Modal } from '@antseed/ui';
import type { ReactNode } from 'react';

interface ActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  variant?: 'default' | 'deposit';
  children: ReactNode;
}

export function ActionModal({ isOpen, onClose, title, subtitle, variant = 'default', children }: ActionModalProps) {
  return (
    <Modal
      bodyClassName="payment-action-dialog__body"
      className={`payment-action-dialog payment-action-dialog--${variant}`}
      closeLabel="Close"
      eyebrow={variant === 'deposit' ? 'Deposit wizard' : undefined}
      isOpen={isOpen}
      onClose={onClose}
      size={variant === 'deposit' ? 'lg' : 'md'}
      subtitle={subtitle}
      title={title}
    >
      {children}
    </Modal>
  );
}
