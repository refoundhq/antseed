import type { HTMLAttributes, ReactNode } from 'react';

export type CardTone = 'surface' | 'muted' | 'accent' | 'danger';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  tone?: CardTone;
}

export function Card({ children, className, tone = 'surface', ...rest }: CardProps) {
  const classes = ['as-card', `as-card--${tone}`, className].filter(Boolean).join(' ');

  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}
