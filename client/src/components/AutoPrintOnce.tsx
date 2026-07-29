import { useEffect, useRef } from "react";

/**
 * Runs an approved document-template printer once after its detail page has
 * mounted. The query flag is removed so refreshing does not print again.
 */
export function AutoPrintOnce({ onPrint }: { onPrint: () => void }) {
  const printedRef = useRef(false);
  const onPrintRef = useRef(onPrint);
  onPrintRef.current = onPrint;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (printedRef.current) return;
      printedRef.current = true;
      onPrintRef.current();
      const url = new URL(window.location.href);
      url.searchParams.delete("print");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }, 150);

    return () => window.clearTimeout(timer);
  }, []);

  return null;
}
