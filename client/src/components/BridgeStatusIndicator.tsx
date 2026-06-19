import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { fetchBridgeStatus, getBridgeSecret, type BridgeStatus } from "@/lib/printing/localBridgeTransport";
import { cn } from "@/lib/utils";

const POLL_MS = 30_000;

/**
 * Small status dot in the sidebar header indicating local-bridge health.
 * Renders nothing when no bridge secret is configured (admin machines / browser-only users).
 *
 * Color semantics:
 *  - green: bridge reachable and at least one configured printer reports online
 *  - amber: bridge reachable but configured printer offline (paper out, unplugged…)
 *  - gray:  bridge unreachable (process not running)
 */
export function BridgeStatusIndicator() {
  const hasSecret = typeof window !== "undefined" && !!getBridgeSecret();
  const [status, setStatus] = useState<BridgeStatus | null>(null);

  useEffect(() => {
    if (!hasSecret) return;
    let alive = true;
    const tick = async () => {
      const s = await fetchBridgeStatus(true);
      if (alive) setStatus(s);
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, POLL_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [hasSecret]);

  if (!hasSecret) return null;
  if (!status) return null;

  let color: "green" | "amber" | "gray" = "gray";
  let label = "جسر الطباعة غير متاح";
  if (status.available) {
    const anyConfigured = status.receiptConfigured || status.labelConfigured;
    const anyOffline = (status.receiptConfigured && status.receiptOnline === false) ||
                       (status.labelConfigured && status.labelOnline === false);
    if (anyConfigured && anyOffline) {
      color = "amber";
      label = "الجسر متصل لكن الطابعة غير جاهزة";
    } else {
      color = "green";
      label = `الجسر متصل${status.version ? ` (v${status.version})` : ""}`;
    }
  }

  const dotClass = color === "green"
    ? "bg-emerald-500 ring-emerald-500/30"
    : color === "amber"
    ? "bg-amber-500 ring-amber-500/30"
    : "bg-gray-400 ring-gray-400/30";

  return (
    <div
      className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
      title={label}
    >
      <Printer className="size-3" />
      <span className={cn("size-2 rounded-full ring-2", dotClass)} aria-label={label} />
    </div>
  );
}
