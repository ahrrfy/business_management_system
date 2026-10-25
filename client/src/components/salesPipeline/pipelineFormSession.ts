import { useEffect, useRef } from "react";

export function localDateTime(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

/** SQL DATE is a calendar date; preserve its string prefix, with UTC for Date values. */
export function dateOnly(value: Date | string | null | undefined): string {
  if (!value) return "";
  if (value instanceof Date)
    return Number.isNaN(value.getTime())
      ? ""
      : value.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "";
}

/** A query refetch must not become a new editing session. Late branch defaults fill only the branch. */
export function usePipelineFormSession({
  open,
  recordKey,
  initialize,
  branchId,
  defaultBranchId,
  setBranchId,
  onBranchChange,
}: {
  open: boolean;
  recordKey: string;
  initialize: () => void;
  branchId: string;
  defaultBranchId: number | null;
  setBranchId: (value: string) => void;
  onBranchChange: (value: number) => void;
}) {
  const activeKey = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      activeKey.current = null;
      return;
    }
    if (activeKey.current !== recordKey) {
      activeKey.current = recordKey;
      initialize();
    } else if (!branchId && defaultBranchId != null) {
      setBranchId(String(defaultBranchId));
      onBranchChange(defaultBranchId);
    }
  }, [
    open,
    recordKey,
    initialize,
    branchId,
    defaultBranchId,
    setBranchId,
    onBranchChange,
  ]);
}
