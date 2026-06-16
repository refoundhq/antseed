import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  fullWidth?: boolean;
  leadingIcon?: ReactNode;
  size?: ButtonSize;
  trailingIcon?: ReactNode;
  variant?: ButtonVariant;
}

export function Button({
  children,
  className,
  fullWidth = false,
  leadingIcon,
  size = "md",
  trailingIcon,
  type = "button",
  variant = "primary",
  ...rest
}: ButtonProps) {
  const classes = [
    "as-button",
    `as-button--${variant}`,
    `as-button--${size}`,
    fullWidth ? "as-button--full" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type={type} className={classes} {...rest}>
      {leadingIcon && (
        <span className="as-button__icon" aria-hidden="true">
          {leadingIcon}
        </span>
      )}
      <span className="as-button__label">{children}</span>
      {trailingIcon && (
        <span className="as-button__icon" aria-hidden="true">
          {trailingIcon}
        </span>
      )}
    </button>
  );
}
