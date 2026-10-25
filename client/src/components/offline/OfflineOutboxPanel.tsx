import { useId, useState } from "react";
import { RefreshCw, Settings2, X } from "lucide-react";
import { PopoverContent } from "@/components/ui/popover";
import type { OfflineOutboxItem } from "@/lib/offline/db";
import type { OutboxSummary } from "@/lib/offline/outbox";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { OfflineDeviceSettings } from "./OfflineDeviceSettings";
import { OfflineOutboxRow } from "./OfflineOutboxRow";
import type { OfflineApprovalApiFactory } from "./offlineReplayApi";
import type { OfflineAction } from "./useOfflineAction";

export function OfflineOutboxPanel({
  summary,
  items,
  offline,
  elevated,
  deviceAction,
  syncPending,
  syncError,
  rowPending,
  rowError,
  activeRowId,
  runRow,
  approvalApi,
  refresh,
  flushNow,
  onClose,
}: {
  summary: OutboxSummary;
  items: OfflineOutboxItem[];
  offline: boolean;
  elevated: boolean;
  deviceAction: OfflineAction;
  syncPending: boolean;
  syncError: string | null;
  rowPending: boolean;
  rowError: string | null;
  activeRowId: string | null;
  runRow: (id: string, task: () => Promise<void>) => Promise<void>;
  approvalApi: OfflineApprovalApiFactory;
  refresh: () => void;
  flushNow: (force?: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const titleId = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      collisionPadding={12}
      aria-labelledby={titleId}
      dir="rtl"
      className="z-[140] flex max-h-[min(70dvh,var(--radix-popover-content-available-height))] w-96 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl p-0"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <h2 id={titleId} className="min-w-0 text-sm font-bold">
          مزامنة المبيعات الأوفلاينية
        </h2>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setSettingsOpen((value) => !value)}
            aria-label="إعدادات الجهاز"
            aria-expanded={settingsOpen}
            className={cn(
              "rounded-md border p-1.5",
              settingsOpen && "bg-muted",
            )}
          >
            <Settings2 aria-hidden className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => void flushNow(true)}
            disabled={summary.flushing || syncPending || offline}
            className="rounded-md border px-2 py-1 text-xs font-semibold disabled:opacity-50"
          >
            <RefreshCw
              aria-hidden
              className={cn(
                "me-1 inline size-3",
                (summary.flushing || syncPending) && "animate-spin",
              )}
            />
            مزامنة الآن
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="rounded-md p-1.5 hover:bg-muted"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
        {syncError ? (
          <p role="alert" className="border-b p-3 text-xs text-destructive">
            {syncError}
          </p>
        ) : null}
        {settingsOpen ? (
          <OfflineDeviceSettings elevated={elevated} action={deviceAction} />
        ) : null}
        {summary.queuedTotal > 0 ? (
          <p className="border-b bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
            قيمة الطابور: <bdi dir="ltr">{fmt(summary.queuedTotal)} د.ع</bdi>
          </p>
        ) : null}
        {items.length ? (
          items.map((item) => (
            <OfflineOutboxRow
              key={item.clientRequestId}
              item={item}
              offline={offline}
              pending={rowPending}
              error={activeRowId === item.clientRequestId ? rowError : null}
              run={(task) => runRow(item.clientRequestId, task)}
              approvalApi={approvalApi}
              flushNow={flushNow}
              refresh={refresh}
            />
          ))
        ) : (
          <p className="p-4 text-center text-xs text-muted-foreground">
            لا عناصر
          </p>
        )}
      </div>
    </PopoverContent>
  );
}
