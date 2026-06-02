import type { HTMLAttributes, ReactNode } from 'react';

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  action?: ReactNode;
  children: ReactNode;
  title?: ReactNode;
  tone?: 'info' | 'success' | 'warning' | 'danger';
}

export function Alert({
  action,
  children,
  className,
  title,
  tone = 'info',
  ...rest
}: AlertProps) {
  const classes = ['as-alert', `as-alert--${tone}`, className].filter(Boolean).join(' ');

  return (
    <div className={classes} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'} {...rest}>
      <div className="as-alert__mark" aria-hidden="true" />
      <div className="as-alert__content">
        {title && <div className="as-alert__title">{title}</div>}
        <div className="as-alert__body">{children}</div>
      </div>
      {action && <div className="as-alert__action">{action}</div>}
    </div>
  );
}
