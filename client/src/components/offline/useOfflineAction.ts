import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg } from "@/lib/notify";

/** One UI action at a time; failures always release the lock and remain visible. */
export function useOfflineAction() {
  const locked = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (task: () => Promise<void>) => {
    if (locked.current || !mounted.current) return;
    locked.current = true;
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      if (mounted.current) setError(`${errMsg(cause)} — أعد المحاولة.`);
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);
  return { run, pending, error };
}

export type OfflineAction = ReturnType<typeof useOfflineAction>;
