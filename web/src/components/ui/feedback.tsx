/** Shared loading / error / empty feedback widgets used by every fetch view. */
import { cn } from "../../lib/cn";
import { Button } from "./button";

/** Animated spinner. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent",
        className,
      )}
    />
  );
}

/** Centered loading state with an optional label. */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

/** Error state with a retry button. */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="max-w-sm text-sm text-red-600">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Neutral empty state. */
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}
