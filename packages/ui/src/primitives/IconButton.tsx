import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export function IconButton({
  children,
  className,
  label,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const classes = ['as-icon-button', className].filter(Boolean).join(' ');

  return (
    <button type={type} className={classes} aria-label={label} title={rest.title ?? label} {...rest}>
      {children}
    </button>
  );
}
