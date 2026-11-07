import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

const ResetScope = createContext<{
  blocked: boolean;
  report: (id: string, locked: boolean) => void;
} | null>(null);

/** Lookup reset must never discard the identity of a financial request awaiting resolution. */
export function WorkflowScanResetScope({
  children,
  onBlockedChange,
}: {
  children: React.ReactNode;
  onBlockedChange?: (blocked: boolean) => void;
}) {
  const locks = useRef(new Set<string>());
  const [blocked, setBlocked] = useState(false);
  useWorkflowResetGuard(blocked);
  const report = useCallback((id: string, locked: boolean) => {
    if (locked) locks.current.add(id);
    else locks.current.delete(id);
    setBlocked(locks.current.size > 0);
  }, []);
  useEffect(() => {
    onBlockedChange?.(blocked);
  }, [blocked, onBlockedChange]);
  const value = useMemo(() => ({ blocked, report }), [blocked, report]);
  return <ResetScope.Provider value={value}>{children}</ResetScope.Provider>;
}

export function useWorkflowResetGuard(locked: boolean) {
  const report = useContext(ResetScope)?.report;
  const id = useId();
  useEffect(() => {
    report?.(id, locked);
    return () => report?.(id, false);
  }, [id, locked, report]);
}

export function useWorkflowResetBlocked() {
  return useContext(ResetScope)?.blocked ?? false;
}

/** Known application rejections are safe to abandon; transport/5xx outcomes need the original retry. */
export function hasUnresolvedWorkflowError(error: unknown): boolean {
  if (!error) return false;
  const data = typeof error === "object" && "data" in error ? error.data : null;
  const status =
    data && typeof data === "object" && "httpStatus" in data
      ? data.httpStatus
      : null;
  return (
    typeof status !== "number" ||
    status >= 500 ||
    status === 408 ||
    status === 499
  );
}

export function WorkflowResetButton({
  onReset,
  disabled = false,
  reason,
}: {
  onReset: () => void;
  disabled?: boolean;
  reason?: string;
}) {
  const locked = useWorkflowResetBlocked();
  const blocked = disabled || locked;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={blocked}
        onClick={() => {
          if (!blocked) onReset();
        }}
      >
        <X className="size-4" aria-hidden /> مسح الاستعلام
      </Button>
      {blocked && (
        <span className="text-xs text-muted-foreground">
          {reason ?? "أكمل العملية الحالية أو استعد نتيجتها قبل مسح الاستعلام."}
        </span>
      )}
    </div>
  );
}
