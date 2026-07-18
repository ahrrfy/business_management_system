import { useCallback, useEffect, useState } from "react";
import { connectivity, useConnectivity } from "@/lib/offline/connectivity";
import {
  flushOutbox,
  listOutboxItems,
  readOutboxSummary,
  replayParkedWithApproval,
  requeueParkedItem,
  subscribeOutbox,
  type OutboxSummary,
  type ReplaySaleApi,
} from "@/lib/offline/outbox";
import type { OfflineOutboxItem } from "@/lib/offline/db";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, CloudUpload, RefreshCw, X } from "lucide-react";

/**
 * شارة مزامنة الكاشير + درج الإيصالات — الشريحة ٣ من خطة الأوفلاين.
 * تظهر فقط حين يوجد ما يستحق (طابور/معلّقات/مزامنة جارية/يلزم دخول) — صفر ضجيج في التشغيل
 * الطبيعي. الطبقة z-[140]: فوق محتوى POS وتحت الشريط العلوي (150) وحوار التأكيد (200).
 * المحفّزات هنا أيضاً: عودة الاتصال + عودة رؤية التبويب + نبضة كل ٣٠ث والطابور غير فارغ.
 */
export function OfflineSyncChip() {
  const connState = useConnectivity();
  const utils = trpc.useUtils();
  const [summary, setSummary] = useState<OutboxSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<OfflineOutboxItem[]>([]);
  // ش٤: اعتماد مدير لعنصر معلَّق (تحت التكلفة) — نموذج مصغّر داخل بطاقة العنصر.
  const [approvalFor, setApprovalFor] = useState<string | null>(null);
  const [mgrEmail, setMgrEmail] = useState("");
  const [mgrPwd, setMgrPwd] = useState("");
  const [approvalBusy, setApprovalBusy] = useState(false);

  const api: ReplaySaleApi = useCallback(
    (args) =>
      utils.client.offline.replaySale.mutate({
        ...(args.payload as never as object),
        capturedAt: args.capturedAt,
        offlineReceiptNumber: args.offlineReceiptNumber,
        deviceId: args.deviceId,
      } as never),
    [utils],
  );

  const refresh = useCallback(() => {
    void readOutboxSummary().then(setSummary);
  }, []);

  const flushNow = useCallback(
    (force = false) => {
      if (connectivity.get() !== "online") return;
      void flushOutbox(api, { force }).then(() => {
        refresh();
        // بعد تفريغٍ ناجح: أنعش شاشات المبيعات/المخزون (الفواتير الرسمية وصلت الآن).
        void utils.catalog.posList.invalidate();
      });
    },
    [api, refresh, utils],
  );

  useEffect(() => {
    refresh();
    const offOutbox = subscribeOutbox(refresh);
    const offConn = connectivity.subscribe((s) => {
      if (s === "online") flushNow();
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") flushNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    const interval = window.setInterval(() => {
      void readOutboxSummary().then((s) => {
        setSummary(s);
        if (s.queued > 0) flushNow();
      });
    }, 30_000);
    // محاولة فورية عند التركيب (بقايا طابور من جلسة سابقة).
    flushNow();
    return () => {
      offOutbox();
      offConn();
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(interval);
    };
  }, [flushNow, refresh]);

  useEffect(() => {
    if (open) void listOutboxItems().then(setItems);
  }, [open, summary]);

  if (!summary) return null;
  const showChip = summary.queued > 0 || summary.parked > 0 || summary.flushing || summary.needsLogin;
  if (!showChip && !open) return null;

  const offline = connState !== "online";
  const chipTone = summary.parked > 0 || summary.needsLogin
    ? "bg-red-600 text-white"
    : summary.flushing
      ? "bg-sky-600 text-white"
      : offline
        ? "bg-amber-500 text-amber-950"
        : "bg-sky-600 text-white";

  const STATUS_LABEL: Record<OfflineOutboxItem["status"], string> = {
    QUEUED: "بالانتظار",
    SENDING: "جارٍ الترحيل",
    SENT: "رُحِّل",
    PARKED: "معلَّق",
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "fixed bottom-3 left-3 z-[140] flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold shadow-lg",
          chipTone,
        )}
      >
        {summary.flushing ? (
          <RefreshCw aria-hidden className="size-3.5 animate-spin" />
        ) : summary.parked > 0 ? (
          <AlertTriangle aria-hidden className="size-3.5" />
        ) : (
          <CloudUpload aria-hidden className="size-3.5" />
        )}
        <span>
          {summary.needsLogin
            ? "سجّل الدخول للمزامنة"
            : summary.flushing
              ? "جارٍ مزامنة المبيعات…"
              : summary.queued > 0
                ? `${summary.queued} بانتظار المزامنة`
                : summary.parked > 0
                  ? `${summary.parked} معلَّقة للمراجعة`
                  : "تمّت المزامنة"}
        </span>
      </button>

      {open ? (
        <div className="fixed bottom-14 left-3 z-[140] flex max-h-[70vh] w-96 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border bg-background text-foreground shadow-2xl">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <p className="text-sm font-bold">مزامنة المبيعات الأوفلاينية</p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => flushNow(true)}
                disabled={summary.flushing || offline}
                className="rounded-md border px-2 py-1 text-xs font-semibold disabled:opacity-50"
              >
                <RefreshCw aria-hidden className={cn("me-1 inline size-3", summary.flushing && "animate-spin")} />
                مزامنة الآن
              </button>
              <button type="button" onClick={() => setOpen(false)} aria-label="إغلاق" className="rounded-md p-1 hover:bg-muted">
                <X aria-hidden className="size-4" />
              </button>
            </div>
          </div>
          {summary.queuedTotal > 0 ? (
            <p className="border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
              قيمة الطابور: {summary.queuedTotal.toLocaleString("en")} د.ع
            </p>
          ) : null}
          <div className="flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">لا عناصر</p>
            ) : (
              items.map((item) => (
                <div key={item.clientRequestId} className="border-b px-3 py-2 text-xs last:border-b-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold">{item.offlineReceiptNumber}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-bold",
                        item.status === "SENT" && "bg-emerald-100 text-emerald-800",
                        item.status === "PARKED" && "bg-red-100 text-red-800",
                        (item.status === "QUEUED" || item.status === "SENDING") && "bg-amber-100 text-amber-900",
                      )}
                    >
                      {STATUS_LABEL[item.status]}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-muted-foreground">
                    <span>{Number(item.total).toLocaleString("en")} د.ع</span>
                    {item.status === "SENT" && item.resultInvoiceNumber ? (
                      <span className="flex items-center gap-1 font-mono">
                        <CheckCircle2 aria-hidden className="size-3 text-emerald-600" />
                        {item.resultInvoiceNumber}
                      </span>
                    ) : null}
                  </div>
                  {item.status === "PARKED" ? (
                    <div className="mt-1 space-y-1">
                      {item.lastError ? <p className="text-red-700 dark:text-red-400">{item.lastError}</p> : null}
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            void requeueParkedItem(item.clientRequestId).then(() => flushNow(true));
                          }}
                          className="rounded border px-2 py-0.5 text-[11px] font-semibold"
                        >
                          إعادة المحاولة
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setApprovalFor((cur) => (cur === item.clientRequestId ? null : item.clientRequestId));
                            setMgrEmail("");
                            setMgrPwd("");
                          }}
                          className="rounded border px-2 py-0.5 text-[11px] font-semibold"
                        >
                          اعتماد مدير
                        </button>
                      </div>
                      {approvalFor === item.clientRequestId ? (
                        <div className="mt-1 space-y-1 rounded-md border bg-muted/40 p-2">
                          <p className="text-[10px] text-muted-foreground">
                            لترحيل بيعٍ رُفض (كسعرٍ تحت التكلفة) — تُتحقَّق هوية المدير خادمياً وتُدقَّق.
                          </p>
                          <input
                            type="email"
                            dir="ltr"
                            value={mgrEmail}
                            onChange={(e) => setMgrEmail(e.target.value)}
                            placeholder="بريد المدير"
                            className="w-full rounded border bg-background px-2 py-1 text-[11px]"
                          />
                          <input
                            type="password"
                            dir="ltr"
                            value={mgrPwd}
                            onChange={(e) => setMgrPwd(e.target.value)}
                            placeholder="كلمة المرور"
                            className="w-full rounded border bg-background px-2 py-1 text-[11px]"
                          />
                          <button
                            type="button"
                            disabled={!mgrEmail || !mgrPwd || approvalBusy || offline}
                            onClick={() => {
                              setApprovalBusy(true);
                              const approvalApi: ReplaySaleApi = (args) =>
                                utils.client.offline.replaySale.mutate({
                                  ...(args.payload as never as object),
                                  capturedAt: args.capturedAt,
                                  offlineReceiptNumber: args.offlineReceiptNumber,
                                  deviceId: args.deviceId,
                                  managerApproval: { email: mgrEmail, password: mgrPwd },
                                } as never);
                              void replayParkedWithApproval(item.clientRequestId, approvalApi).then((r) => {
                                setApprovalBusy(false);
                                if (r.ok) {
                                  setApprovalFor(null);
                                  setMgrEmail("");
                                  setMgrPwd("");
                                }
                                refresh();
                              });
                            }}
                            className="w-full rounded bg-sky-600 px-2 py-1 text-[11px] font-bold text-white disabled:opacity-50"
                          >
                            {approvalBusy ? "جارٍ الترحيل…" : "اعتماد وترحيل"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
