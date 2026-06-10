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
      bodyClassName="action-modal-body"
      className={`action-modal-card action-modal-card--${variant}`}
      closeLabel="Close"
      eyebrow={variant === 'deposit' ? 'Deposit wizard' : undefined}
      isOpen={isOpen}
      onClose={onClose}
      overlayClassName="action-modal-overlay"
      size={variant === 'deposit' ? 'lg' : 'md'}
      subtitle={subtitle}
      title={title}
    >
      {children}
    </Modal>
  );
}
