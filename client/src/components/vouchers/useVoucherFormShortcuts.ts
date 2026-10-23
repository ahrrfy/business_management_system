import { useEffect, useRef } from "react";

export type VoucherPrintMode = "thermal" | "a4" | null;

/** Bind once while always invoking the current, complete form submission. */
export function useVoucherFormShortcuts(callbacks: {
  isReceipt: boolean;
  submit: (mode: VoucherPrintMode) => unknown;
  requestCancel: () => unknown;
}) {
  const latest = useRef(callbacks);
  latest.current = callbacks;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        void latest.current.requestCancel();
      } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void latest.current.submit(latest.current.isReceipt ? "thermal" : null);
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        void latest.current.submit(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
