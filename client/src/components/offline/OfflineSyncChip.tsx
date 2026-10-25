import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CloudOff, CloudUpload, RefreshCw } from "lucide-react";
import { connectivity, useConnectivity } from "@/lib/offline/connectivity";
import {
  flushOutbox,
  listOutboxItems,
  readOutboxSummary,
  subscribeOutbox,
  type OutboxSummary,
} from "@/lib/offline/outbox";
import type { OfflineOutboxItem } from "@/lib/offline/db";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { OfflineOutboxPanel } from "./OfflineOutboxPanel";
import {
  createOfflineReplayApi,
  type OfflineManagerApproval,
  type OfflineReplayRoutes,
} from "./offlineReplayApi";
import { useOfflineAction } from "./useOfflineAction";

/** Shared cashier queue: preserve all replay kinds, identity and online/visibility/30s triggers. */
export function OfflineSyncChip({
  userRole,
  placement = "floating",
}: {
  userRole?: string | null;
  placement?: "floating" | "inline";
}) {
  const connState = useConnectivity();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery(undefined, { retry: false });
  const currentUserId = Number(me.data?.id ?? 0) || null;
  const [summary, setSummary] = useState<OutboxSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<OfflineOutboxItem[]>([]);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const deviceAction = useOfflineAction();
  const {
    run: runSync,
    pending: syncPending,
    error: syncError,
  } = useOfflineAction();
  const {
    run: runRowAction,
    pending: rowPending,
    error: rowError,
  } = useOfflineAction();
  const routes = useMemo<OfflineReplayRoutes>(
    () => ({
      SALE: (input) => utils.client.offline.replaySale.mutate(input),
      PRINT_SALE: (input) => utils.client.offline.replayPrintSale.mutate(input),
      RECEPTION: (input) => utils.client.offline.replayReception.mutate(input),
      RETURN: (input) => utils.client.offline.replayReturn.mutate(input),
    }),
    [utils],
  );
  const api = useMemo(() => createOfflineReplayApi(routes), [routes]);
  const approvalApi = useCallback(
    (approval: OfflineManagerApproval) =>
      createOfflineReplayApi(routes, approval),
    [routes],
  );
  const refresh = useCallback(() => {
    void readOutboxSummary().then(setSummary);
  }, []);
  const flushNow = useCallback(
    async (force = false) => {
      if (connectivity.get() !== "online" || currentUserId == null) return;
      await runSync(async () => {
        await flushOutbox(api, { force, currentUserId });
        refresh();
        // Cache refresh belongs to its screen; it must not retain the replay lock.
        void Promise.resolve(utils.catalog.posList.invalidate()).catch(
          (error) => notify.err(error),
        );
      });
    },
    [api, currentUserId, refresh, runSync, utils],
  );
  const runRow = useCallback(
    (id: string, task: () => Promise<void>) =>
      runRowAction(async () => {
        setActiveRowId(id);
        await task();
      }),
    [runRowAction],
  );
  useEffect(() => {
    refresh();
    const offOutbox = subscribeOutbox(refresh);
    const offConn = connectivity.subscribe((state) => {
      if (state === "online") void flushNow();
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") void flushNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    const interval = window.setInterval(() => {
      void readOutboxSummary().then((value) => {
        setSummary(value);
        if (value.queued > 0) void flushNow();
      });
    }, 30_000);
    void flushNow();
    return () => {
      offOutbox();
      offConn();
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(interval);
    };
  }, [flushNow, refresh]);
  useEffect(() => {
    let active = true;
    if (open)
      void listOutboxItems().then((value) => {
        if (active) setItems(value);
      });
    return () => {
      active = false;
    };
  }, [open, summary]);
  if (!summary) return null;
  const busy =
    summary.queued > 0 ||
    summary.parked > 0 ||
    summary.flushing ||
    summary.needsLogin;
  const offline = connState !== "online";
  const chipTone =
    summary.parked > 0 || summary.needsLogin
      ? "bg-[var(--sem-neg)] text-background"
      : summary.flushing
        ? "bg-primary text-primary-foreground"
        : offline
          ? "bg-[var(--sem-warn)] text-background"
          : busy
            ? "bg-primary text-primary-foreground"
            : "border bg-background/90 text-muted-foreground";
  return (
    <Popover modal={false} open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            placement === "floating"
              ? "fixed bottom-3 left-3 z-[140] flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold shadow-lg"
              : "inline-flex h-[var(--ui-control)] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-bold",
            chipTone,
          )}
        >
          {summary.flushing ? (
            <RefreshCw aria-hidden className="size-3.5 animate-spin" />
          ) : summary.parked > 0 ? (
            <AlertTriangle aria-hidden className="size-3.5" />
          ) : offline ? (
            <CloudOff aria-hidden className="size-3.5" />
          ) : (
            <CloudUpload aria-hidden className="size-3.5" />
          )}
          <span>
            {summary.needsLogin
              ? "سجل الدخول للمزامنة"
              : summary.flushing
                ? "قيد مزامنة المبيعات…"
                : summary.queued > 0
                  ? `${summary.queued} بانتظار المزامنة`
                  : summary.parked > 0
                    ? `${summary.parked} معلقة للمراجعة`
                    : offline
                      ? "دون اتصال"
                      : "الأوفلاين"}
          </span>
        </button>
      </PopoverTrigger>
      <OfflineOutboxPanel
        summary={summary}
        items={items}
        offline={offline}
        elevated={userRole === "admin" || userRole === "manager"}
        syncPending={syncPending}
        syncError={syncError}
        deviceAction={deviceAction}
        rowPending={rowPending}
        rowError={rowError}
        activeRowId={activeRowId}
        runRow={runRow}
        approvalApi={approvalApi}
        refresh={refresh}
        flushNow={flushNow}
        onClose={() => setOpen(false)}
      />
    </Popover>
  );
}
