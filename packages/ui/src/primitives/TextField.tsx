import type { InputHTMLAttributes, ReactNode } from 'react';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: ReactNode;
  hint?: ReactNode;
  label?: ReactNode;
}

export function TextField({
  className,
  error,
  hint,
  id,
  label,
  ...rest
}: TextFieldProps) {
  const inputId = id ?? rest.name;
  const classes = ['as-field', className].filter(Boolean).join(' ');

  return (
    <label className={classes} htmlFor={inputId}>
      {label && <span className="as-field__label">{label}</span>}
      <input id={inputId} className="as-field__input" {...rest} />
      {error ? (
        <span className="as-field__error">{error}</span>
      ) : hint ? (
        <span className="as-field__hint">{hint}</span>
      ) : null}
    </label>
  );
}
