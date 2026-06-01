import type { HTMLAttributes } from 'react';

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  height?: number | string;
  radius?: number | string;
  width?: number | string;
}

export function Skeleton({ className, height, radius, style, width, ...rest }: SkeletonProps) {
  const classes = ['as-skeleton', className].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      style={{
        ...style,
        ...(height !== undefined ? { height } : {}),
        ...(radius !== undefined ? { borderRadius: radius } : {}),
        ...(width !== undefined ? { width } : {}),
      }}
      {...rest}
    />
  );
}
