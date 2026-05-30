/**
 * Minimal data-fetching hook: tracks { data, loading, error } and exposes a
 * `reload` for retry buttons. Avoids an external query lib for this small app.
 *
 * The async function is identified by `deps`; changing deps re-runs it. A guard
 * flag drops results from stale runs so out-of-order responses never clobber a
 * newer one.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Coerce any thrown value into a friendly, render-safe message. */
function toMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return "Something went wrong. Please try again.";
}

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
  options?: { enabled?: boolean },
): AsyncState<T> {
  const enabled = options?.enabled ?? true;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<string | null>(null);
  // Bump to force a manual reload independent of deps.
  const [nonce, setNonce] = useState(0);
  const runIdRef = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setData(null);
      setError(null);
      return;
    }
    const runId = ++runIdRef.current;
    setLoading(true);
    setError(null);
    fn()
      .then((result) => {
        if (runId === runIdRef.current) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (runId === runIdRef.current) {
          setError(toMessage(err));
          setLoading(false);
        }
      });
    // fn is intentionally excluded; deps + nonce drive re-execution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps]);

  return { data, loading, error, reload };
}
