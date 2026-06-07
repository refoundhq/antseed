import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

interface LoaderOverlayProps {
  isVisible: boolean;
  error?: boolean;
  onRetry?: () => void;
}

export function LoaderOverlay({ isVisible, error = false, onRetry }: LoaderOverlayProps) {
  useBodyScrollLock(isVisible);

  if (!isVisible) return null;

  if (error) {
    return (
      <div className="loader-overlay" role="alert" aria-live="assertive">
        <div className="loader-overlay-card loader-overlay-card--error">
          <p className="loader-overlay-error-text">
            Can’t reach the payments server. Retrying…
          </p>
          {onRetry && (
            <button type="button" className="loader-overlay-retry" onClick={onRetry}>
              Retry now
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="loader-overlay" role="status" aria-live="polite" aria-label="Loading">
      <div className="loader-overlay-card">
        <div className="loader-overlay-spinner" />
      </div>
    </div>
  );
}
